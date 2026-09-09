import { parseReflectionProposal } from "./autonomy-reflection-validation.ts";
import type {
	AutonomySource,
	GoalState,
	NeedState,
	ReflectionProposal,
} from "./autonomy-types.ts";
import { ownedExperienceEvidence, validateReflectionGrowth } from "./growth.ts";
import { lifeDigest } from "./life-json.ts";
import { knowsClaimAt } from "./life-knowledge.ts";
import { refKey } from "./life-record-validation.ts";
import type {
	AgentBelief,
	AgentExperience,
	GrowthDelta,
	LifeClaim,
} from "./life-types.ts";

export { parseReflectionProposal } from "./autonomy-reflection-validation.ts";
export interface ReflectionSupplement {
	claims: LifeClaim[];
	beliefs: AgentBelief[];
	experiences: AgentExperience[];
	growth: GrowthDelta[];
	needs: NeedState[];
	goals: GoalState[];
}
function currentEvidence(
	source: AutonomySource,
	agentId: string,
	ids: string[],
): AgentExperience[] {
	const rows = ownedExperienceEvidence(source, agentId, ids);
	if (
		!rows.some(
			(x) => x.eventId === `${source.life.worldId}:${source.world.revision}`,
		)
	)
		throw Error("Reflection requires current observation evidence");
	return rows;
}
/** Bind untrusted own proposals to actual observations; no proposal grants truth or disclosure authority. */
export function bindReflection(
	source: AutonomySource,
	agentId: string,
	stepId: string,
	value: ReflectionProposal,
): ReflectionSupplement {
	const p = parseReflectionProposal(value),
		eventId = `${source.world.definition.id}:${source.world.revision}`;
	if (
		!source.pack.life.participants.includes(agentId) ||
		!source.life.experiences.some(
			(x) => x.agentId === agentId && x.eventId === eventId,
		)
	)
		throw Error("Reflection requires an owned current observation");
	const result: ReflectionSupplement = {
		claims: [],
		beliefs: [],
		experiences: [],
		growth: [],
		needs: [],
		goals: [],
	};
	const projected = structuredClone(source);
	for (const claim of p.claims) {
		if (projected.life.claims.some((x) => x.id === claim.id))
			throw Error("Reflection claim already exists");
		if (claim.supersedes !== null) {
			const prior = projected.life.claims.find(
				(x) => x.id === claim.supersedes,
			);
			if (
				!prior ||
				prior.truth !== "unknown" ||
				prior.disclosure.knowers.length !== 1 ||
				prior.disclosure.knowers[0] !== agentId ||
				projected.life.claims.some((x) => x.supersedes === prior.id)
			)
				throw Error("Invalid owned claim supersession");
		}
		const bound: LifeClaim = {
			...claim,
			sourceEventId: eventId,
			truth: "unknown",
			disclosure: { knowers: [agentId], disclosures: [], publication: [] },
		};
		const experience: AgentExperience = {
			id: `inference-${lifeDigest([stepId, agentId, claim.id]).slice(0, 40)}`,
			agentId,
			eventId,
			channel: "inferred",
			claims: [{ kind: "life_claim", id: claim.id }],
			simulationTime: source.world.simulationTime,
		};
		result.claims.push(bound);
		result.experiences.push(experience);
		projected.life.claims.push(bound);
		projected.life.experiences.push(experience);
	}
	for (const belief of p.beliefs) {
		const evidence = currentEvidence(source, agentId, belief.experienceIds);
		if (!knowsClaimAt(belief.claim, agentId, projected.world, projected.life))
			throw Error("Reflection belief exceeds own knowledge");
		if (projected.life.beliefs.some((x) => x.id === belief.id))
			throw Error("Reflection belief already exists");
		if (belief.supersedes !== null) {
			const prior = projected.life.beliefs.find(
				(x) => x.id === belief.supersedes,
			);
			if (
				!prior ||
				prior.agentId !== agentId ||
				projected.life.beliefs.some((x) => x.supersedes === prior.id)
			)
				throw Error("Invalid owned belief supersession");
		}
		const replaced = new Set(
			projected.life.beliefs.flatMap((x) =>
				x.supersedes ? [x.supersedes] : [],
			),
		);
		if (
			projected.life.beliefs.some(
				(x) =>
					x.agentId === agentId &&
					refKey(x.claim) === refKey(belief.claim) &&
					!replaced.has(x.id) &&
					x.id !== belief.supersedes,
			)
		)
			throw Error("Reflection needs belief supersession");
		const inference = result.experiences.find((x) =>
			x.claims.some((c) => refKey(c) === refKey(belief.claim)),
		);
		if (
			!inference &&
			evidence.some(
				(x) => !x.claims.some((c) => refKey(c) === refKey(belief.claim)),
			)
		)
			throw Error("Belief evidence lacks claim observation");
		const bound = {
			...belief,
			agentId,
			experienceIds: inference
				? [inference.id]
				: [...belief.experienceIds].sort(),
		};
		result.beliefs.push(bound);
		projected.life.beliefs.push(bound);
	}
	result.growth = validateReflectionGrowth(source, agentId, p.growth);
	for (const need of p.needs) {
		currentEvidence(source, agentId, need.experienceIds);
		const definition = source.pack.autonomy.needs.find(
				(x) => x.id === need.needId,
			),
			row = source.autonomy.needs.find(
				(x) => x.agentId === agentId && x.needId === need.needId,
			);
		if (
			!definition ||
			!row ||
			need.next < definition.min ||
			need.next > definition.max
		)
			throw Error("Invalid reflection need bounds");
		result.needs.push({
			...row,
			value: need.next,
			lastStepId: stepId,
			experienceIds: need.experienceIds,
		});
	}
	for (const goal of p.goals) {
		currentEvidence(source, agentId, goal.experienceIds);
		if (
			goal.familyIds.some(
				(id) => !source.pack.autonomy.events.some((x) => x.familyId === id),
			)
		)
			throw Error("Unknown reflection goal family");
		const prior = source.autonomy.goals.find((x) => x.id === goal.id);
		if (
			prior &&
			(prior.agentId !== agentId ||
				prior.description !== goal.description ||
				lifeDigest(prior.familyIds) !== lifeDigest(goal.familyIds))
		)
			throw Error("Reflection cannot reinterpret goal identity");
		if (prior && prior.status !== "active" && goal.status !== prior.status)
			throw Error("Reflection cannot reopen closed goal");
		result.goals.push({
			...goal,
			agentId,
			createdAtStepId: prior ? prior.createdAtStepId : stepId,
			lastStepId: stepId,
		});
	}
	return result;
}
