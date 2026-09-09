import { lifeDigest } from "./life-json.ts";
import type {
	AgentExperience,
	GrowthDelta,
	KnowledgeGrant,
	LifeCommitV2,
} from "./life-types.ts";
import type { SocialResolution, SocialResolveInput } from "./social-types.ts";

/** Deterministic ledger projection of a verified result. Narration and beliefs belong to the later runner. */
export function socialResolutionCommit(
	input: SocialResolveInput,
	result: SocialResolution,
): LifeCommitV2 {
	if (result.kind !== "advanced")
		throw Error("Unchanged social result cannot create an event");
	const worldId = input.world.definition.id,
		nextLife = input.life.revision + 1;
	const eventId = `${worldId}:${input.world.revision + 1}`;
	const prefix = `social-${lifeDigest({ worldId, requestId: input.requestId }).slice(0, 40)}`;
	const actorId = input.intent.agentId;
	const entry = result.effects.find(
		(effect) => effect.kind === "move" && effect.agentId === actorId,
	);
	const scene =
		input.world.scenes.find((x) => x.occupants.includes(actorId)) ??
		(entry?.kind === "move"
			? input.world.scenes.find((x) => x.id === entry.sceneId)
			: undefined);
	if (!scene) throw Error("Social actor has no event scene");
	const audience = new Set([actorId]);
	if (input.intent.targetAgentId !== null)
		audience.add(input.intent.targetAgentId);
	const experiences: AgentExperience[] = [
		{
			id: `${prefix}-attempt`,
			agentId: actorId,
			eventId,
			channel: "direct",
			claims: [],
			simulationTime: input.simulationTime,
		},
	];
	const grants: KnowledgeGrant[] = [];
	const growth: GrowthDelta[] = [];
	const moves: Array<{ agentId: string; sceneId: string }> = [];
	for (const [index, effect] of result.effects.entries()) {
		if (effect.kind === "move")
			moves.push({ agentId: effect.agentId, sceneId: effect.sceneId });
		if (effect.kind === "reveal") {
			const policy = input.policies.find(
				(x) =>
					x.claim.kind === effect.claim.kind && x.claim.id === effect.claim.id,
			);
			if (!policy) throw Error("Social reveal lacks frozen policy");
			const experienceId = `${prefix}-learn-${index}`;
			audience.add(effect.toAgentId);
			experiences.push({
				id: experienceId,
				agentId: effect.toAgentId,
				eventId,
				channel: "told",
				claims: [effect.claim],
				simulationTime: input.simulationTime,
			});
			grants.push({
				id: `${prefix}-grant-${index}`,
				claim: effect.claim,
				fromAgentId: effect.fromAgentId,
				toAgentId: effect.toAgentId,
				sourceEventId: eventId,
				experienceId,
				lifeRevision: nextLife,
				definitionRevision: policy.definitionRevision,
				projectionRevision: policy.projectionRevision,
				policyDigest: policy.policyDigest,
			});
		}
		if (effect.kind === "predicate") {
			const axisId = input.rulePack.predicates.find(
				(x) => x.id === effect.predicateId,
			)?.policy.attitudeAxisId;
			if (!axisId || effect.previous === effect.next) continue;
			if (
				effect.secondAgentId === null ||
				typeof effect.previous !== "number" ||
				typeof effect.next !== "number"
			)
				throw Error("Invalid mapped social attitude");
			const evidenceId = `${prefix}-attitude-${index}`;
			// Internal attitude consequences are private inferences; they do not grant witness access to the event.
			experiences.push({
				id: evidenceId,
				agentId: effect.firstAgentId,
				eventId,
				channel: "inferred",
				claims: [],
				simulationTime: input.simulationTime,
			});
			growth.push({
				kind: "attitude",
				fromAgentId: effect.firstAgentId,
				toAgentId: effect.secondAgentId,
				axisId,
				previous: effect.previous,
				next: effect.next,
				evidenceIds: [evidenceId],
			});
		}
	}
	return {
		version: 2,
		socialResolutionId: input.requestId,
		expectedLifeRevision: input.life.revision,
		definitionRevision: input.life.definitionRevision,
		world: {
			worldId,
			idempotencyKey: prefix,
			expectedRevision: input.world.revision,
			simulationTime: input.simulationTime,
			kind: "activity",
			sceneId: scene.id,
			actorIds: [actorId],
			audience: [...audience].sort(),
			summary: `${result.outcome === "accepted" ? "Accepted" : "Rejected"} attempt: ${input.intent.description}`,
			facts: [],
			moves,
		},
		claims: [],
		beliefs: [],
		experiences,
		growth,
		knowledgeGrants: grants,
		checkpoint: result.checkpoint,
		consumedInputIds: [],
		effects: [],
	};
}
