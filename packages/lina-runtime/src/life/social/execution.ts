import { lifeDigest } from "../../../../lina-core/src/world/life-json.ts";
import { validateSocialCheckpoint } from "../../../../lina-core/src/world/social-checkpoint.ts";
import { encodeSocialValue } from "../../../../lina-core/src/world/social-codec.ts";
import type {
	SocialResolution,
	SocialResolveInput,
} from "../../../../lina-core/src/world/social-types.ts";
import { socialPredicateCategory } from "../../../../lina-core/src/world/social-views.ts";
import {
	checkpointEnsemble,
	engineRandom,
	initializeEnsemble,
} from "./checkpoint.ts";
import { assertEngineWrite, primitiveChanges, readValues } from "./effects.ts";
import { createPinnedEnsemble } from "./pinned.ts";
import type {
	EnginePredicate,
	PinnedEnsemble,
	RootResolution,
} from "./pinned-types.ts";
import { engineTables } from "./tables.ts";

function checkDepth(input: SocialResolveInput): void {
	const nodes = new Map(
		input.rulePack.definition.actions.map((a) => [a.id, a]),
	);
	for (const primitive of input.intent.primitives)
		if (primitive.kind === "attempt") {
			const stack = [{ id: primitive.rootActionId, depth: 1 }];
			let visits = 0;
			while (stack.length) {
				const current = stack.pop();
				if (!current) break;
				if (
					++visits > input.limits.maxOperations ||
					current.depth > input.limits.maxDepth
				)
					throw Error("Social action depth budget exceeded");
				const node = nodes.get(current.id);
				if (!node) throw Error("Unknown social action");
				if (node.kind !== "terminal")
					for (const child of node.children)
						stack.push({ id: child, depth: current.depth + 1 });
			}
		}
}
function historicalWindow(
	input: SocialResolveInput,
	predicate: EnginePredicate,
	recent: number,
	old: number,
	step: number,
): [number, number] | null {
	// Every bootstrap predicate and participant is introduced at social step zero.
	if (input.checkpoint.engineId !== "ensemble")
		return recent > step ? null : [recent, Math.min(old, step)];
	const data = input.checkpoint.data;
	const p = input.rulePack.predicates.find(
		(p) => socialPredicateCategory(p.id) === predicate.category,
	);
	const introduction = data.predicateIntroductions.find(
		(i) => i.id === p?.id,
	)?.socialStep;
	const first = data.agentIntroductions.find(
		(i) => i.id === predicate.first,
	)?.socialStep;
	const second = predicate.second
		? data.agentIntroductions.find((i) => i.id === predicate.second)?.socialStep
		: 0;
	if (introduction === undefined || first === undefined || second === undefined)
		return null;
	const oldest = step - Math.max(introduction, first, second);
	return recent > oldest ? null : [recent, Math.min(old, oldest)];
}
function rootWeight(
	input: SocialResolveInput,
	engine: PinnedEnsemble,
	cast: string[],
	rootId: string | null,
): number {
	const volition = engine.api.calculateVolition(cast);
	const root = input.rulePack.definition.actions.find((a) => a.id === rootId);
	if (root?.kind !== "root") return 0;
	const def = input.rulePack.predicates.find(
		(p) => p.id === root.intent.predicateId,
	);
	const target =
		def?.direction === "undirected"
			? input.intent.agentId
			: (input.intent.targetAgentId ?? input.intent.agentId);
	let row = volition.getFirst(input.intent.agentId, target);
	while (row) {
		if (
			row.category === socialPredicateCategory(root.intent.predicateId) &&
			row.intentType === root.intent.intentType
		)
			return row.weight ?? 0;
		row = volition.getNext(input.intent.agentId, target);
	}
	return 0;
}

/** Used only inside the owned worker. Each call creates a separate pinned engine instance. */
export function executeSocialResolution(
	input: SocialResolveInput,
): SocialResolution {
	validateSocialCheckpoint(input.checkpoint, input.rulePack);
	checkDepth(input);
	const random = engineRandom(input),
		tables = engineTables(input.rulePack);
	let initialized = false,
		resourcesAllowed = false,
		collectTriggers = false,
		operations = 0,
		bindings = 0;
	const triggerIds = new Set<string>();
	const engine = createPinnedEnsemble({
		random: random.random,
		bindingAllowed: tables.bindingAllowed,
		fixedBinding: tables.fixedBinding,
		tick: (kind) => {
			if (++operations > input.limits.maxOperations)
				throw Error("Social operation budget exceeded");
			if (kind === "binding" && ++bindings > input.limits.maxBindings)
				throw Error("Social binding budget exceeded");
		},
		window: (p, recent, old, step) =>
			historicalWindow(input, p, recent, old, step),
		beforeSet: (p) => {
			if (initialized) assertEngineWrite(input, p, engine, resourcesAllowed);
		},
		matched: (id) => {
			if (collectTriggers) {
				triggerIds.add(id);
				if (triggerIds.size > input.limits.maxTraceEntries)
					throw Error("Social trace budget exceeded");
			}
		},
	});
	tables.load(engine);
	initializeEnsemble(input, engine);
	initialized = true;
	const immutable = JSON.stringify(encodeSocialValue(engine.definitions()));
	const before = readValues(input, engine);
	const drawsBefore = random.state.drawIndex;
	const inactive = engine.readState();
	const cast = input.rulePack.cast
		.filter(
			(c) =>
				c.active &&
				!inactive.offstage.includes(c.agentId) &&
				!inactive.eliminated.includes(c.agentId),
		)
		.map((c) => c.agentId);
	if (
		!cast.includes(input.intent.agentId) ||
		(input.intent.targetAgentId !== null &&
			!cast.includes(input.intent.targetAgentId))
	)
		throw Error("Inactive social participant");
	const attempt = input.intent.primitives.find((p) => p.kind === "attempt");
	const rootId = attempt?.kind === "attempt" ? attempt.rootActionId : null;
	const capability = input.rulePack.definition.capabilities.find(
		(c) => c.id === input.intent.capabilityId,
	);
	if (!capability) throw Error("Unknown social capability");
	const primitives = primitiveChanges(input, before);
	const eligible = engine.evaluateConditions(
		capability.conditions.map((c) =>
			tables.condition(c, input.intent.agentId, input.intent.targetAgentId),
		),
	);
	const accepted =
		primitives !== null &&
		eligible &&
		input.targetResponse?.decision !== "reject";
	// A social step advances once for a valid attempt, independent of authored wall time.
	engine.api.setupNextTimeStep();
	const weight = rootWeight(input, engine, cast, rootId);
	const selected: RootResolution = rootId
		? engine.resolveRoot(
				rootId,
				input.intent.agentId,
				input.intent.targetAgentId ?? input.intent.agentId,
				accepted,
				weight,
				cast,
				input.limits.maxTraceEntries,
			)
		: { action: null, bindings: {}, candidateIds: [] };
	if (selected.candidateIds.length > input.limits.maxTraceEntries)
		throw Error("Social candidate budget exceeded");
	const outcome =
		accepted && (rootId === null || selected.action !== null)
			? "accepted"
			: "rejected";
	if (selected.action) engine.api.doAction(selected.action);
	const effects =
		outcome === "accepted" && primitives ? primitives.effects : [];
	if (outcome === "accepted" && primitives) {
		resourcesAllowed = true;
		for (const transfer of primitives.transfers) engine.api.set(transfer);
		resourcesAllowed = false;
	}
	collectTriggers = true;
	engine.api.runTriggerRules(cast);
	collectTriggers = false;
	if (
		triggerIds.size + selected.candidateIds.length >
		input.limits.maxTraceEntries
	)
		throw Error("Social trace budget exceeded");
	for (const [key, value] of readValues(input, engine)) {
		const old = before.get(key);
		if (old && old.next !== value.next)
			effects.push({ ...value, previous: old.next });
	}
	if (JSON.stringify(encodeSocialValue(engine.definitions())) !== immutable)
		throw Error("Social immutable tables mutated");
	const checkpoint = checkpointEnsemble(input, engine, random.state);
	const body: Omit<
		Extract<SocialResolution, { kind: "advanced" }>,
		"resultDigest"
	> = {
		version: 1,
		requestId: input.requestId,
		inputDigest: lifeDigest(input),
		previousCheckpointDigest: lifeDigest(input.checkpoint),
		kind: "advanced",
		outcome,
		effects,
		checkpoint,
		trace: {
			rootActionId: rootId,
			terminalActionId: selected.action?.name ?? null,
			bindings: Object.fromEntries(
				Object.entries(selected.bindings).filter(
					(entry): entry is [string, string] => typeof entry[1] === "string",
				),
			),
			candidateIds: selected.candidateIds,
			triggerIds: [...triggerIds].sort(),
			drawsBefore,
			drawsAfter: random.state.drawIndex,
			rejection:
				outcome === "accepted"
					? null
					: !primitives || !eligible
						? "primitive_precondition"
						: input.targetResponse?.decision === "reject"
							? "target_rejected"
							: "no_eligible_terminal",
		},
	};
	return { ...body, resultDigest: lifeDigest(body) };
}
