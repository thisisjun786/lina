import { lifeDigest } from "./life-json.ts";
import {
	boundSocialNode,
	enumerateSocialBindings,
	type SocialBoundAgents,
	socialReferenceKey,
} from "./social-effect-bindings.ts";
import {
	type BoundSocialWrite,
	createSocialEffectState,
	type SocialEffectState,
	socialCellKey,
} from "./social-effect-state.ts";
import type {
	SocialAction,
	SocialResolution,
	SocialResolveInput,
} from "./social-types.ts";

type Advanced = Extract<SocialResolution, { kind: "advanced" }>;

function permittedTransfers(
	input: SocialResolveInput,
	state: SocialEffectState,
): BoundSocialWrite[] | null {
	const balances = new Map<string, number>(),
		transfers: BoundSocialWrite[] = [];
	for (const primitive of input.intent.primitives) {
		if (primitive.kind !== "transfer") continue;
		const p = state.definition(primitive.predicateId);
		for (const [agent, delta] of [
			[input.intent.agentId, -primitive.amount],
			[primitive.toAgentId, primitive.amount],
		] as const) {
			const key = socialCellKey(p.id, agent, null),
				before = balances.get(key) ?? state.read(p.id, agent, null);
			if (typeof before !== "number")
				throw Error("Invalid replay resource balance");
			const next = before + delta;
			if (
				!Number.isFinite(next) ||
				next < (p.min ?? 0) ||
				next > (p.max ?? Number.MAX_SAFE_INTEGER)
			)
				return null;
			balances.set(key, next);
			transfers.push({
				predicateId: p.id,
				first: agent,
				second: null,
				operator: "=",
				value: next,
			});
		}
	}
	return transfers;
}

function selectedAction(
	input: SocialResolveInput,
	result: Advanced,
	state: SocialEffectState,
	accepted: boolean,
): { action: SocialAction; bindings: SocialBoundAgents } | null {
	const attempt = input.intent.primitives.find((p) => p.kind === "attempt");
	if (attempt?.kind !== "attempt") {
		if (result.trace.terminalActionId !== null)
			throw Error("Rootless result selected a terminal");
		return null;
	}
	const actions = new Map(
		input.rulePack.definition.actions.map((a) => [a.id, a]),
	);
	let anyTerminal = false,
		selected: { action: SocialAction; bindings: SocialBoundAgents } | null =
			null;
	const seed = {
		initiator: input.intent.agentId,
		responder: input.intent.targetAgentId ?? input.intent.agentId,
	};
	function visit(id: string, prior: SocialBoundAgents, depth: number): boolean {
		state.tick();
		if (depth > input.limits.maxDepth)
			throw Error("Social effect replay action depth exceeded");
		const action = actions.get(id);
		if (!action) throw Error("Unknown replay action");
		const scope = `a:${action.id}`;
		return enumerateSocialBindings(
			input,
			state,
			action,
			scope,
			prior,
			(bindings) => {
				if (
					!action.conditions.every((c) =>
						state.condition(boundSocialNode(c, scope, bindings)),
					)
				)
					return false;
				if (action.kind !== "terminal") {
					for (const child of action.children)
						if (visit(child, bindings, depth + 1)) return true;
					return false;
				}
				if (
					action.acceptance !== "either" &&
					action.acceptance !== (accepted ? "accepted" : "rejected")
				)
					return false;
				anyTerminal = true;
				if (action.id !== result.trace.terminalActionId) return false;
				if (
					Object.entries(bindings).some(
						([key, agent]) => result.trace.bindings[key] !== agent,
					)
				)
					return false;
				selected = { action, bindings };
				return true;
			},
		);
	}
	visit(attempt.rootActionId, seed, 1);
	if (!selected && (result.trace.terminalActionId !== null || anyTerminal))
		throw Error("Social terminal or declared conditions mismatch");
	return selected;
}

/** Re-enumerates all rule matches, including repeated bindings and no-op writes. */
function triggers(
	input: SocialResolveInput,
	state: SocialEffectState,
): string[] {
	const ignored =
		input.checkpoint.engineId === "ensemble"
			? input.checkpoint.data.state.eliminated
			: [];
	const matched: string[] = [];
	for (const rule of input.rulePack.definition.triggers) {
		const scope = `t:${rule.id}`;
		let fired = false;
		enumerateSocialBindings(input, state, rule, scope, {}, (bindings) => {
			const writes = rule.effects.map((e) =>
				boundSocialNode(e, scope, bindings),
			);
			const allowed = (write: BoundSocialWrite) =>
				!ignored.includes(write.first) &&
				(write.second === null || !ignored.includes(write.second));
			if (
				!writes.some(allowed) ||
				!rule.conditions.every((c) =>
					state.condition(boundSocialNode(c, scope, bindings)),
				)
			)
				return false;
			fired = true;
			for (const write of writes) if (allowed(write)) state.write(write);
			return false;
		});
		if (fired) matched.push(rule.id);
	}
	return matched;
}

/** Checks operations and metadata from trusted definitions, never from reported deltas or trigger counts. */
export function assertSocialEffectAuthority(
	input: SocialResolveInput,
	result: Advanced,
): void {
	const state = createSocialEffectState(input),
		transfers = permittedTransfers(input, state);
	const capability = input.rulePack.definition.capabilities.find(
		(c) => c.id === input.intent.capabilityId,
	);
	if (!capability) throw Error("Unknown replay capability");
	const context: SocialBoundAgents = {
		initiator: input.intent.agentId,
		responder: input.intent.targetAgentId ?? input.intent.agentId,
	};
	for (const condition of capability.conditions)
		for (const ref of [condition.first, condition.second])
			if (ref?.kind === "agent")
				context[socialReferenceKey(ref, "capability")] = ref.agentId;
	const eligible =
		transfers !== null &&
		capability.conditions.every((c) =>
			state.condition(boundSocialNode(c, "capability", context)),
		) &&
		input.targetResponse?.decision !== "reject";
	state.advance();
	const selected = selectedAction(input, result, state, eligible);
	const hasRoot = input.intent.primitives.some((p) => p.kind === "attempt");
	const outcome =
		eligible && (!hasRoot || selected !== null) ? "accepted" : "rejected";
	if (result.outcome !== outcome)
		throw Error("Social result contradicts authoritative preconditions");
	if (selected?.action.kind === "terminal")
		for (const effect of selected.action.effects)
			state.write(
				boundSocialNode(effect, `a:${selected.action.id}`, selected.bindings),
			);
	if (outcome === "accepted" && transfers)
		for (const transfer of transfers) state.write(transfer, "lina-transfer");
	if (
		lifeDigest(triggers(input, state)) !== lifeDigest(result.trace.triggerIds)
	)
		throw Error("Social trigger coverage mismatch");
	state.validate(result.checkpoint);
}
