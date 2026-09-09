import { lifeDigest } from "./life-json.ts";
import { validateSocialCheckpoint } from "./social-checkpoint.ts";
import { decodeSocialValue, encodeSocialValue } from "./social-codec.ts";
import { assertSocialEffectAuthority } from "./social-effect-authority.ts";
import {
	parseSocialResolution,
	parseSocialResolveInput,
} from "./social-resolution-validation.ts";
import { assertSocialValue } from "./social-semantics.ts";
import type {
	SocialEffect,
	SocialResolution,
	SocialResolveInput,
} from "./social-types.ts";
import { socialInputVariables } from "./social-variables.ts";
import { currentSocialValue } from "./social-views.ts";

const predicateKey = (id: string, first: string, second: string | null) =>
	JSON.stringify([id, first, second]);

/** Jump the fixed LCG in O(log(draws)), without accepting a reseeded continuation. */
function randomAfter(state: number, draws: number): number {
	let a = 1664525n,
		c = 1013904223n,
		n = BigInt(draws),
		value = BigInt(state);
	const mask = 0xffffffffn;
	while (n > 0n) {
		if (n & 1n) value = (a * value + c) & mask;
		c = (c * (a + 1n)) & mask;
		a = (a * a) & mask;
		n >>= 1n;
	}
	return Number(value);
}

function checkpointTransition(
	input: SocialResolveInput,
	result: Extract<SocialResolution, { kind: "advanced" }>,
): void {
	const previous =
			input.checkpoint.engineId === "ensemble" ? input.checkpoint.data : null,
		next = result.checkpoint.data;
	if (
		next.worldRevision !== input.world.revision + 1 ||
		next.lifeRevision !== input.life.revision + 1 ||
		next.simulationTime !== input.simulationTime ||
		next.state.step !== (previous?.state.step ?? 0) + 1
	)
		throw Error("Invalid social result boundary");
	const draws = previous?.rng.drawIndex ?? 0,
		state = previous?.rng.state ?? input.bootstrap?.seed,
		seed = previous?.rng.seed ?? input.bootstrap?.seed;
	if (
		state === undefined ||
		next.rng.seed !== seed ||
		next.rng.drawIndex < draws ||
		next.rng.state !== randomAfter(state, next.rng.drawIndex - draws) ||
		result.trace.drawsBefore !== draws ||
		result.trace.drawsAfter !== next.rng.drawIndex
	)
		throw Error("Social result random continuity mismatch");
	const expectedVariables = socialInputVariables(input);
	if (lifeDigest(next.variables) !== lifeDigest(expectedVariables))
		throw Error("Unauthorized social variable write");
	if (previous) {
		for (const key of [
			"predicateIntroductions",
			"agentIntroductions",
			"variableIntroductions",
			"cast",
		] as const)
			if (lifeDigest(next[key]) !== lifeDigest(previous[key]))
				throw Error("Social result changed introductions or cast");
		for (const key of ["offstage", "eliminated"] as const)
			if (lifeDigest(next.state[key]) !== lifeDigest(previous.state[key]))
				throw Error("Unauthorized social cast change");
		for (const [key, value] of Object.entries(previous.state.iterators))
			if ((next.state.iterators[key] ?? -1) < value)
				throw Error("Social counter regression");
		const before = decodeSocialValue(previous.state.history),
			after = decodeSocialValue(next.state.history);
		if (
			!Array.isArray(before) ||
			!Array.isArray(after) ||
			lifeDigest(encodeSocialValue(after.slice(0, before.length))) !==
				lifeDigest(previous.state.history)
		)
			throw Error("Social result rewrote prior history");
	} else {
		if (
			next.state.eliminated.length ||
			lifeDigest([...next.state.offstage].sort()) !==
				lifeDigest(
					input.rulePack.cast
						.filter((c) => !c.active)
						.map((c) => c.agentId)
						.sort(),
				)
		)
			throw Error("Unauthorized initial social cast change");
		for (const i of [
			...next.predicateIntroductions,
			...next.agentIntroductions,
			...next.variableIntroductions,
		])
			if (i.socialStep !== 0 || i.worldRevision !== input.world.revision)
				throw Error("Invalid initial social introduction");
	}
}

function trace(
	input: SocialResolveInput,
	result: Extract<SocialResolution, { kind: "advanced" }>,
): void {
	const attempt = input.intent.primitives.find((p) => p.kind === "attempt"),
		root = attempt?.kind === "attempt" ? attempt.rootActionId : null;
	if (
		result.trace.rootActionId !== root ||
		(result.outcome === "accepted" &&
			(input.targetResponse?.decision === "reject" ||
				result.trace.rejection !== null)) ||
		(result.outcome === "rejected" && result.trace.rejection === null)
	)
		throw Error("Social result outcome mismatch");
	const reachable = new Set<string>(),
		stack = root ? [root] : [];
	while (stack.length) {
		const id = stack.pop();
		if (!id || reachable.has(id)) continue;
		reachable.add(id);
		const node = input.rulePack.definition.actions.find((a) => a.id === id);
		if (node && node.kind !== "terminal") stack.push(...node.children);
	}
	const terminal = input.rulePack.definition.actions.find(
		(a) => a.id === result.trace.terminalActionId,
	);
	if (
		result.trace.terminalActionId !== null &&
		(!reachable.has(result.trace.terminalActionId) ||
			terminal?.kind !== "terminal" ||
			(terminal.acceptance !== "either" &&
				terminal.acceptance !== result.outcome))
	)
		throw Error("Social result terminal mismatch");
	if (root !== null && result.outcome === "accepted" && !terminal)
		throw Error("Accepted social result requires a terminal");
	for (const id of result.trace.candidateIds)
		if (
			!reachable.has(id) ||
			input.rulePack.definition.actions.find((a) => a.id === id)?.kind !==
				"terminal"
		)
			throw Error("Unknown social candidate");
	for (const id of result.trace.triggerIds)
		if (!input.rulePack.definition.triggers.some((r) => r.id === id))
			throw Error("Unknown social trigger");
	for (const [key, agent] of Object.entries(result.trace.bindings))
		if (
			!input.rulePack.cast.some((c) => c.agentId === agent && c.active) ||
			(key === "initiator" && agent !== input.intent.agentId) ||
			(key === "responder" &&
				agent !== (input.intent.targetAgentId ?? input.intent.agentId))
		)
			throw Error("Invalid social result binding");
	if (
		result.trace.candidateIds.length + result.trace.triggerIds.length >
		input.limits.maxTraceEntries
	)
		throw Error("Social trace budget exceeded");
}

function primitives(
	input: SocialResolveInput,
	accepted: boolean,
): { effects: SocialEffect[]; balances: Map<string, number> } {
	const effects: SocialEffect[] = [],
		balances = new Map<string, number>();
	if (!accepted) return { effects, balances };
	for (const primitive of input.intent.primitives) {
		switch (primitive.kind) {
			case "attempt":
				break;
			case "move":
				effects.push({
					kind: "move",
					agentId: input.intent.agentId,
					sceneId: primitive.sceneId,
				});
				break;
			case "goal":
				effects.push({
					kind: "goal",
					agentId: input.intent.agentId,
					goalId: primitive.goalId,
					description: primitive.description,
				});
				break;
			case "reveal":
				effects.push({
					kind: "reveal",
					fromAgentId: input.intent.agentId,
					toAgentId: primitive.toAgentId,
					claim: primitive.claim,
				});
				break;
			case "transfer": {
				const predicate = input.rulePack.predicates.find(
					(p) => p.id === primitive.predicateId,
				);
				if (!predicate?.policy.resource) throw Error("Invalid social resource");
				for (const [agent, delta] of [
					[input.intent.agentId, -primitive.amount],
					[primitive.toAgentId, primitive.amount],
				] as const) {
					const key = predicateKey(predicate.id, agent, null),
						value =
							balances.get(key) ??
							currentSocialValue(
								input.rulePack,
								input.life,
								predicate,
								agent,
								null,
							);
					if (typeof value !== "number")
						throw Error("Invalid social transfer balance");
					const next = value + delta;
					assertSocialValue(predicate, next);
					if (next - value !== delta)
						throw Error("Lossy social transfer arithmetic");
					balances.set(key, next);
				}
			}
		}
	}
	return { effects, balances };
}

function effects(
	input: SocialResolveInput,
	result: Extract<SocialResolution, { kind: "advanced" }>,
): void {
	assertSocialEffectAuthority(input, result);
	const expected = primitives(input, result.outcome === "accepted"),
		actual = result.effects.filter((e) => e.kind !== "predicate");
	if (lifeDigest(actual) !== lifeDigest(expected.effects))
		throw Error("Social primitive effects mismatch");
	const reported = new Map<
		string,
		Extract<SocialEffect, { kind: "predicate" }>
	>();
	for (const effect of result.effects)
		if (effect.kind === "predicate") {
			const key = predicateKey(
				effect.predicateId,
				effect.firstAgentId,
				effect.secondAgentId,
			);
			if (reported.has(key) || effect.previous === effect.next)
				throw Error("Duplicate or unchanged social effect");
			reported.set(key, effect);
		}
	const life = { ...input.life, checkpoint: result.checkpoint };
	for (const predicate of input.rulePack.predicates)
		for (const first of input.rulePack.cast) {
			const seconds =
				predicate.direction === "undirected"
					? [null]
					: input.rulePack.cast
							.filter((c) => c.agentId !== first.agentId)
							.map((c) => c.agentId);
			for (const second of seconds) {
				const key = predicateKey(predicate.id, first.agentId, second),
					before = currentSocialValue(
						input.rulePack,
						input.life,
						predicate,
						first.agentId,
						second,
					),
					after = currentSocialValue(
						input.rulePack,
						life,
						predicate,
						first.agentId,
						second,
					),
					effect = reported.get(key);
				if (before === null || after === null)
					throw Error("Unknown social effect value");
				if (
					predicate.policy.resource &&
					after !== (expected.balances.get(key) ?? before)
				)
					throw Error("Social resource conservation mismatch");
				if (before === after) {
					if (effect) throw Error("Unchanged social effect");
					continue;
				}
				if (!effect || effect.previous !== before || effect.next !== after)
					throw Error("Social effect does not match checkpoint delta");
				if (predicate.policy.attitudeAxisId !== null) {
					const identity = input.identity.profiles.find(
						(p) => p.agentId === first.agentId,
					);
					if (
						identity?.evolution !== "adaptive" ||
						identity.lockedAttitudeIds.includes(predicate.policy.attitudeAxisId)
					)
						throw Error("Social identity axis locked");
				}
				reported.delete(key);
			}
		}
	if (reported.size) throw Error("Unknown social predicate effect");
}

export function validateSocialResult(
	inputValue: SocialResolveInput,
	resultValue: SocialResolution,
): SocialResolution {
	const input = parseSocialResolveInput(inputValue),
		result = parseSocialResolution(resultValue);
	if (
		result.requestId !== input.requestId ||
		result.inputDigest !== lifeDigest(input) ||
		result.previousCheckpointDigest !== lifeDigest(input.checkpoint)
	)
		throw Error("Social result source mismatch");
	if (result.kind === "unchanged")
		throw Error("Known social intent cannot produce an extension result");
	validateSocialCheckpoint(input.checkpoint, input.rulePack);
	validateSocialCheckpoint(result.checkpoint, input.rulePack);
	checkpointTransition(input, result);
	trace(input, result);
	effects(input, result);
	if (Buffer.byteLength(JSON.stringify(result)) > input.limits.maxBytes)
		throw Error("Social result byte budget exceeded");
	return result;
}
