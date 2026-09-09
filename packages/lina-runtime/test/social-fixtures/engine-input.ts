import type { WorldPackV2 } from "../../../lina-core/src/world/authoring-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import { initialLifeState } from "../../../lina-core/src/world/life-transition.ts";
import { compileSocialPack } from "../../../lina-core/src/world/social-compile.ts";
import type {
	SocialResolution,
	SocialResolveInput,
} from "../../../lina-core/src/world/social-types.ts";
import { initialSnapshot } from "../../../lina-core/src/world/transition.ts";
import { MAX_WORLD_BYTES } from "../../../lina-core/src/world/validation.ts";
import { identityPolicy } from "../../../lina-core/test/life-fixture.ts";
import {
	socialIntent,
	socialPack,
} from "../../../lina-core/test/life-social-pack-fixture.ts";

export function engineInput(
	pack: WorldPackV2 = socialPack(),
): SocialResolveInput {
	const world = initialSnapshot(pack.world);
	const life = initialLifeState(world, pack.life);
	const bootstrap = {
		version: 1 as const,
		worldId: pack.worldId,
		algorithm: "lcg32-v1" as const,
		seed: 123456,
	};
	return {
		version: 1,
		requestId: "social-1",
		world,
		life,
		identity: identityPolicy(),
		checkpoint: life.checkpoint,
		rulePack: compileSocialPack(pack),
		intent: socialIntent(),
		targetResponse: {
			intentId: "intent-1",
			agentId: "mira",
			decision: "accept",
		},
		simulationTime: 1,
		bootstrap: { ...bootstrap, digest: lifeDigest(bootstrap) },
		policies: [],
		limits: {
			maxOperations: 10000,
			maxBindings: 4096,
			maxDepth: 20,
			maxBytes: MAX_WORLD_BYTES,
			maxHistoryEntries: 1000,
			maxTraceEntries: 1000,
		},
	};
}
export function continueInput(
	input: SocialResolveInput,
	result: SocialResolution,
): SocialResolveInput {
	if (result.kind !== "advanced")
		throw Error("Expected advanced fixture result");
	const next = structuredClone(input);
	next.requestId = `${input.requestId}-next`;
	next.world.revision++;
	next.world.simulationTime++;
	next.life.version = 2;
	if (!("knowledgeGrants" in next.life))
		Object.assign(next.life, { knowledgeGrants: [] });
	next.life.revision++;
	next.life.worldRevision++;
	next.life.checkpoint = result.checkpoint;
	next.checkpoint = result.checkpoint;
	next.bootstrap = null;
	next.simulationTime++;
	for (const effect of result.effects) {
		if (effect.kind !== "predicate") continue;
		const policy = next.rulePack.predicates.find(
			(p) => p.id === effect.predicateId,
		)?.policy;
		if (!policy?.attitudeAxisId) continue;
		const attitude = next.life.attitudes.find(
			(a) =>
				a.axisId === policy.attitudeAxisId &&
				a.fromAgentId === effect.firstAgentId &&
				a.toAgentId === effect.secondAgentId,
		);
		if (attitude && typeof effect.next === "number")
			attitude.value = effect.next;
	}
	return next;
}

export function richPack(): WorldPackV2 {
	const pack = socialPack();
	pack.predicates.push(
		{
			id: "closeness",
			type: "number",
			direction: "directed",
			initial: 0,
			min: 0,
			max: 100,
		},
		{
			id: "confident",
			type: "boolean",
			direction: "undirected",
			initial: false,
			min: null,
			max: null,
		},
		{
			id: "friends",
			type: "boolean",
			direction: "reciprocal",
			initial: false,
			min: null,
			max: null,
		},
	);
	pack.social.policies.push(
		{
			predicateId: "closeness",
			duration: null,
			visibility: { kind: "first" },
			resource: false,
			attitudeAxisId: null,
		},
		{
			predicateId: "confident",
			duration: 3,
			visibility: { kind: "public" },
			resource: false,
			attitudeAxisId: null,
		},
		{
			predicateId: "friends",
			duration: null,
			visibility: { kind: "public" },
			resource: false,
			attitudeAxisId: null,
		},
	);
	const first = { kind: "agent" as const, agentId: "lina" },
		second = { kind: "agent" as const, agentId: "mira" };
	pack.social.volitions = [
		{
			id: "private-reluctance",
			bindings: [],
			conditions: [],
			effects: [
				{ predicateId: "trust", first, second, intentType: true, weight: -30 },
			],
		},
	];
	pack.social.triggers = [
		{
			id: "friendship-after-second",
			bindings: [],
			conditions: [
				{
					predicateId: "closeness",
					first,
					second,
					operator: ">",
					value: 15,
					window: null,
				},
			],
			effects: [
				{ predicateId: "friends", first, second, operator: "=", value: true },
			],
		},
	];
	pack.social.actions = [
		{
			id: "aaa-other-root",
			kind: "root",
			bindings: [],
			conditions: [],
			influence: [],
			intent: { predicateId: "trust", intentType: true },
			children: ["wrong"],
		},
		{
			id: "wrong",
			kind: "terminal",
			bindings: [],
			conditions: [],
			influence: [],
			acceptance: "either",
			effects: [
				{ predicateId: "closeness", first, second, operator: "=", value: 99 },
			],
		},
		{
			id: "greet",
			kind: "root",
			bindings: [],
			conditions: [],
			influence: [],
			intent: { predicateId: "trust", intentType: true },
			children: ["conversation"],
		},
		{
			id: "conversation",
			kind: "group",
			bindings: [],
			conditions: [],
			influence: [],
			children: ["yes-a", "yes-b", "no"],
		},
		...["yes-a", "yes-b"].map((id) => ({
			id,
			kind: "terminal" as const,
			bindings: [{ id: "witness", roleId: "resident", agentId: "sol" }],
			conditions: [],
			influence: [],
			acceptance: "accepted" as const,
			effects: [
				{
					predicateId: "closeness",
					first,
					second,
					operator: "+" as const,
					value: 10,
				},
				{
					predicateId: "confident",
					first: { kind: "binding" as const, id: "witness" },
					second: null,
					operator: "=" as const,
					value: true,
				},
			],
		})),
		{
			id: "no",
			kind: "terminal",
			bindings: [],
			conditions: [],
			influence: [],
			acceptance: "rejected",
			effects: [
				{ predicateId: "closeness", first, second, operator: "+", value: 2 },
			],
		},
	];
	return pack;
}
