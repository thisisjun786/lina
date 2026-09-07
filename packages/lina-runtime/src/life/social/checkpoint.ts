import { lifeDigest } from "../../../../lina-core/src/world/life-json.ts";
import { parseEnsembleCheckpoint } from "../../../../lina-core/src/world/social-checkpoint-validation.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../../../../lina-core/src/world/social-codec.ts";
import type {
	EnsembleCheckpoint,
	SocialResolveInput,
	SocialRng,
} from "../../../../lina-core/src/world/social-types.ts";
import { socialPredicateCategory as predicateCategory } from "../../../../lina-core/src/world/social-views.ts";
import type { PinnedEnsemble, RawEnsembleState } from "./pinned-types.ts";

export function engineRandom(input: SocialResolveInput) {
	const previous =
		input.checkpoint.engineId === "ensemble" ? input.checkpoint.data.rng : null;
	const seed = previous?.seed ?? input.bootstrap?.seed;
	if (seed === undefined) throw Error("Social bootstrap required");
	const state: SocialRng = previous
		? { ...previous }
		: { algorithm: "lcg32-v1", seed, state: seed, drawIndex: 0 };
	return {
		state,
		random: () => {
			if (state.drawIndex >= Number.MAX_SAFE_INTEGER)
				throw Error("Social RNG exhausted");
			state.state = (Math.imul(state.state, 1664525) + 1013904223) >>> 0;
			state.drawIndex++;
			return state.state / 4294967296;
		},
	};
}

export function restoreEnsemble(
	checkpoint: EnsembleCheckpoint,
	engine: PinnedEnsemble,
): void {
	const parsed = parseEnsembleCheckpoint(checkpoint);
	const state: RawEnsembleState = {
		...parsed.data.state,
		history: decodeSocialValue(parsed.data.state.history),
		volitionCache: decodeSocialValue(parsed.data.state.volitionCache),
	};
	const built = engine.readState().iterators;
	for (const [key, value] of Object.entries(built))
		if ((state.iterators[key] ?? 0) < value)
			throw Error("Social static counter mismatch");
	engine.writeState(state);
}

export function initializeEnsemble(
	input: SocialResolveInput,
	engine: PinnedEnsemble,
): void {
	if (input.checkpoint.engineId === "ensemble") {
		restoreEnsemble(input.checkpoint, engine);
		return;
	}
	engine.api.setupNextTimeStep(0);
	const initial = engine.readState();
	engine.writeState({
		...initial,
		iterators: { ...initial.iterators, socialRecords: 0 },
	});
	const cast = input.rulePack.cast.map((c) => c.agentId);
	for (const p of input.rulePack.predicates)
		for (const first of cast) {
			const seconds =
				p.direction === "undirected"
					? [null]
					: cast.filter((id) => id !== first);
			for (const second of seconds) {
				// Reciprocal initialization writes both directions once through the real engine.
				if (p.direction === "reciprocal" && second !== null && second < first)
					continue;
				const mapped = p.policy.attitudeAxisId
					? input.life.attitudes.find(
							(a) =>
								a.axisId === p.policy.attitudeAxisId &&
								a.fromAgentId === first &&
								a.toAgentId === second,
						)?.value
					: undefined;
				engine.api.set({
					category: predicateCategory(p.id),
					type: "value",
					first,
					...(second === null ? {} : { second }),
					value: mapped ?? p.initial,
					origin: "lina-bootstrap",
				});
			}
		}
	for (const member of input.rulePack.cast)
		if (!member.active) engine.api.setCharacterOffstage(member.agentId);
}

export function checkpointEnsemble(
	input: SocialResolveInput,
	engine: PinnedEnsemble,
	rng: SocialRng,
): EnsembleCheckpoint {
	const raw = engine.readState();
	const previous =
		input.checkpoint.engineId === "ensemble" ? input.checkpoint.data : null;
	const data: EnsembleCheckpoint["data"] = {
		worldId: input.rulePack.worldId,
		packVersion: input.rulePack.packVersion,
		worldRevision: input.world.revision + 1,
		lifeRevision: input.life.revision + 1,
		simulationTime: input.simulationTime,
		compilerRevision: 1,
		schemaDigest: input.rulePack.schemaDigest,
		actionDigest: input.rulePack.actionDigest,
		cast: previous
			? [...previous.cast]
			: input.rulePack.cast.map((c) => c.agentId),
		variables: previous
			? structuredClone(previous.variables)
			: Object.fromEntries(
					input.rulePack.variables.map((v) => [v.id, v.initial]),
				),
		predicateIntroductions: previous
			? structuredClone(previous.predicateIntroductions)
			: input.rulePack.predicates.map((p) => ({
					id: p.id,
					socialStep: 0,
					worldRevision: input.world.revision,
				})),
		variableIntroductions: previous
			? structuredClone(previous.variableIntroductions)
			: input.rulePack.variables.map((v) => ({
					id: v.id,
					socialStep: 0,
					worldRevision: input.world.revision,
				})),
		agentIntroductions: previous
			? structuredClone(previous.agentIntroductions)
			: input.rulePack.cast.map((c) => ({
					id: c.agentId,
					socialStep: 0,
					worldRevision: input.world.revision,
				})),
		state: {
			...raw,
			history: encodeSocialValue(raw.history),
			volitionCache: encodeSocialValue(raw.volitionCache),
		},
		rng: { ...rng },
	};
	if (
		Array.isArray(raw.history) &&
		raw.history.reduce(
			(n, slice) => n + (Array.isArray(slice) ? slice.length : 0),
			0,
		) > input.limits.maxHistoryEntries
	)
		throw Error("Social history budget exceeded");
	return parseEnsembleCheckpoint({
		version: 1,
		engineId: "ensemble",
		engineRevision: "8b74bdec-lina-1",
		ruleDigest: input.rulePack.ruleDigest,
		encodingVersion: 1,
		dataDigest: lifeDigest(data),
		data,
	});
}
