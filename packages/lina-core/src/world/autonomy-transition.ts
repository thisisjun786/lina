import { rebindSocialCheckpoint } from "./autonomy-migration.ts";
import {
	completedLifeModelText,
	completedStepIntent,
	completedStepTarget,
} from "./autonomy-model-text.ts";
import { applyAutonomyRules } from "./autonomy-rules.ts";
import {
	assertAutonomySource,
	assertAutonomyVariables,
} from "./autonomy-source.ts";
import type {
	AutonomyOutcome,
	AutonomyState,
	LifeStep,
} from "./autonomy-types.ts";
import { parseAutonomyState } from "./autonomy-validation.ts";
import { assertLifeEventWeights } from "./events.ts";
import { bindReflection, parseReflectionProposal } from "./experience.ts";
import { finite, lifeDigest, revision } from "./life-json.ts";
import { applyLifeTransition } from "./life-transition.ts";
import type { LifeCommitV3, LifeState } from "./life-types.ts";
import { applyPublicationBudget } from "./publication-budget.ts";
import { applyPublicationExperiences } from "./publication-experience.ts";
import { socialResolutionCommit } from "./social-commit.ts";
import { compileSocialPack } from "./social-compile.ts";
import { validateSocialResult } from "./social-result.ts";
import type { SocialPreparedResolution } from "./social-store-types.ts";
import { transition } from "./transition.ts";
import type { WorldSnapshot } from "./types.ts";
import { applyWorkExperiences } from "./work-experience.ts";

export {
	initialAutonomyState,
	migrateAutonomyState,
	rebindSocialCheckpoint,
} from "./autonomy-migration.ts";

function tick(step: LifeStep): LifeCommitV3 {
	return {
		version: 3,
		stepId: step.id,
		socialResolutionId: null,
		expectedLifeRevision: step.source.life.revision,
		definitionRevision: step.source.life.definitionRevision,
		world: {
			worldId: step.worldId,
			idempotencyKey: step.idempotencyKey,
			expectedRevision: step.source.world.revision,
			simulationTime: step.decision.simulationTime,
			kind: "tick",
			sceneId: null,
			actorIds: [],
			audience: [],
			summary: "",
			facts: [],
			moves: [],
		},
		claims: [],
		beliefs: [],
		experiences: [],
		growth: [],
		knowledgeGrants: [],
		checkpoint: structuredClone(step.source.life.checkpoint),
		consumedInputIds: [],
		effects: [],
	};
}
function nextState(step: LifeStep): AutonomyState {
	assertAutonomySource(step.source);
	const limits = step.source.config.limits;
	if (!limits) throw Error("Autonomy limits unconfigured");
	const state = structuredClone(step.source.autonomy);
	state.worldRevision = revision(state.worldRevision + 1);
	state.lifeRevision = revision(state.lifeRevision + 1);
	state.stepNumber = revision(state.stepNumber + 1);
	for (const row of state.needs) {
		if (
			!step.source.pack.roles.some(
				(r) => r.agentId === row.agentId && r.status === "active",
			)
		)
			continue;
		const def = step.source.pack.autonomy.needs.find(
			(n) => n.id === row.needId,
		);
		if (!def) throw Error("Unknown need state");
		row.value = Math.max(
			def.min,
			Math.min(def.max, finite(row.value + def.driftPerStep)),
		);
		row.lastStepId = step.id;
	}
	if (step.decision.kind === "event")
		state.selectionIndex = revision(state.selectionIndex + 1);
	for (const row of state.pendingEvents)
		if (row.depth > limits.maxCausalDepth) row.status = "stopped";
	return state;
}
function prepareBase(
	step: LifeStep,
	social: SocialPreparedResolution | null,
): {
	kind: AutonomyOutcome["kind"];
	state: AutonomyState;
	commit: LifeCommitV3;
} {
	const clock = step.source.config.clock;
	if (!clock) throw Error("Autonomy clock unconfigured");
	const state = nextState(step);
	let commit = tick(step),
		kind: AutonomyOutcome["kind"] = "quiet";
	if (
		step.decision.stepId !== step.id ||
		step.worldId !== step.source.pack.worldId ||
		step.decision.simulationTime !==
			step.source.world.simulationTime + clock.stepSize
	)
		throw Error("Autonomy step boundary mismatch");
	if (step.decision.kind === "quiet") {
		if (social || step.models.length || step.intent)
			throw Error("Quiet step contains model activity");
	} else {
		const { agentId, familyId, parent } = step.decision;
		if (!agentId || !familyId)
			throw Error("Autonomy selected opportunity missing");
		completedLifeModelText(step, "director", agentId);
		const inspected = completedStepIntent(step);
		if (inspected.kind === "extension") {
			kind = "extension_required";
			if (social?.result?.kind === "advanced")
				throw Error("Extension cannot contain successful social effects");
		} else {
			const target = completedStepTarget(step, inspected.intent);
			if (
				!social ||
				!social.result ||
				"kind" in social.input ||
				social.input.version !== 2 ||
				social.worldId !== step.worldId ||
				social.requestId !== step.socialRequestId ||
				(social.acceptedLifeRevision !== null &&
					social.acceptedLifeRevision !== state.lifeRevision)
			)
				throw Error("Missing owned staged autonomous social resolution");
			const input = social.input;
			if (
				lifeDigest(input.world) !== lifeDigest(step.source.world) ||
				lifeDigest(input.life) !== lifeDigest(step.source.life) ||
				lifeDigest(input.identity) !== lifeDigest(step.source.identity) ||
				lifeDigest(input.intent) !== lifeDigest(inspected.intent) ||
				lifeDigest(input.targetResponse) !== lifeDigest(target) ||
				lifeDigest(input.rulePack) !==
					lifeDigest(compileSocialPack(step.source.pack)) ||
				input.simulationTime !== step.decision.simulationTime ||
				input.autonomy.stepId !== step.id ||
				input.autonomy.stateDigest !== lifeDigest(step.source.autonomy) ||
				lifeDigest(input.autonomy.variables) !==
					lifeDigest(step.source.autonomy.variables) ||
				social.inputDigest !== lifeDigest(input)
			)
				throw Error("Autonomy social source mismatch");
			const result = validateSocialResult(input, social.result);
			commit = {
				...socialResolutionCommit(input, result),
				version: 3,
				stepId: step.id,
			};
			kind = "activity";
			// The actor's free narration is private. Publication receives only this neutral outcome.
			commit.world.summary = `${result.outcome === "accepted" ? "Accepted" : "Rejected"} social attempt`;
			for (const agentId of [
				inspected.intent.agentId,
				...(target ? [target.agentId] : []),
			])
				if (!commit.experiences.some((x) => x.agentId === agentId))
					commit.experiences.push({
						id: `observation-${lifeDigest([step.id, agentId]).slice(0, 40)}`,
						agentId,
						eventId: `${step.worldId}:${state.worldRevision}`,
						channel: "observed",
						claims: [],
						simulationTime: step.decision.simulationTime,
					});
			for (const effect of result.effects)
				if (effect.kind === "goal") {
					const prior = state.goals.find((g) => g.id === effect.goalId);
					if (
						prior &&
						(prior.agentId !== effect.agentId ||
							prior.description !== effect.description)
					)
						throw Error("Social goal identity conflict");
					if (!prior)
						state.goals.push({
							id: effect.goalId,
							agentId: effect.agentId,
							description: effect.description,
							priority: 0,
							familyIds: [familyId],
							progress: 0,
							status: "active",
							createdAtStepId: step.id,
							lastStepId: step.id,
							experienceIds: commit.experiences
								.filter((x) => x.agentId === effect.agentId)
								.map((x) => x.id),
						});
				}
		}
		const family = state.families.find(
			(x) =>
				x.familyId === step.decision.familyId &&
				x.agentId === step.decision.agentId,
		);
		if (family) {
			family.lastStepNumber = state.stepNumber;
			family.count = revision(family.count + 1);
		} else
			state.families.push({
				familyId: familyId,
				agentId: agentId,
				lastStepNumber: state.stepNumber,
				count: 1,
			});
		if (parent)
			state.pendingEvents = state.pendingEvents.filter(
				(x) => x.id !== parent.id,
			);
	}
	applyWorkExperiences(step, commit);
	if (kind === "quiet" && commit.world.kind === "activity") kind = "work";
	applyPublicationExperiences(step, commit);
	if (kind === "quiet" && commit.world.kind === "activity") kind = "feedback";
	applyAutonomyRules(step, state, commit, kind !== "activity");
	applyPublicationBudget(step, state);
	assertAutonomyVariables(step.source.pack, state.variables);
	commit.checkpoint = rebindSocialCheckpoint(
		commit.checkpoint,
		{
			worldRevision: state.worldRevision,
			lifeRevision: state.lifeRevision,
			simulationTime: step.decision.simulationTime,
		},
		state.variables,
	);
	return { kind, state: parseAutonomyState(state), commit };
}
function observation(
	base: ReturnType<typeof prepareBase>,
	step: LifeStep,
): { world: WorldSnapshot; life: LifeState; agentIds: string[] } {
	const world = transition(step.source.world, base.commit.world);
	const life = applyLifeTransition(
		step.source.life,
		step.source.world,
		world,
		step.source.pack.life,
		base.commit,
		step.source.identity,
	);
	const agentIds =
		base.kind === "activity"
			? [
					...new Set([
						...base.commit.experiences.map((x) => x.agentId),
						...base.commit.knowledgeGrants.map((x) => x.toAgentId),
					]),
				].sort()
			: [];
	return { world, life, agentIds };
}
export function prepareAutonomyObservation(
	step: LifeStep,
	social: SocialPreparedResolution | null,
): { world: WorldSnapshot; life: LifeState; agentIds: string[] } {
	return observation(prepareBase(step, social), step);
}
export function buildAutonomyOutcome(
	step: LifeStep,
	social: SocialPreparedResolution | null,
): AutonomyOutcome {
	const base = prepareBase(step, social);
	if (base.kind === "activity") {
		const staged = observation(base, step);
		if (lifeDigest(staged.agentIds) !== lifeDigest(step.reflectionAgentIds))
			throw Error("Autonomy reflection recipient mismatch");
		const reflectionRows = step.models.filter(
			(r) => r.prepared.request.lane === "reflection",
		);
		if (reflectionRows.length !== staged.agentIds.length)
			throw Error("Autonomy requires every authorized reflection");
		for (const agentId of staged.agentIds) {
			const p = parseReflectionProposal(
				JSON.parse(completedLifeModelText(step, "reflection", agentId)),
			);
			const supplement = bindReflection(
				{
					...step.source,
					world: staged.world,
					life: staged.life,
					autonomy: base.state,
				},
				agentId,
				step.id,
				p,
			);
			base.commit.claims.push(...supplement.claims);
			base.commit.beliefs.push(...supplement.beliefs);
			base.commit.experiences.push(...supplement.experiences);
			base.commit.growth.push(...supplement.growth);
			for (const need of supplement.needs) {
				const i = base.state.needs.findIndex(
					(x) => x.agentId === need.agentId && x.needId === need.needId,
				);
				base.state.needs[i] = need;
			}
			for (const goal of supplement.goals) {
				const i = base.state.goals.findIndex((x) => x.id === goal.id);
				if (i < 0) base.state.goals.push(goal);
				else base.state.goals[i] = goal;
			}
		}
		const payload = {
			kind: "publication_candidate" as const,
			eventId: `${step.worldId}:${base.state.worldRevision}`,
		};
		base.commit.effects.push({
			version: 1,
			worldId: step.worldId,
			id: `publication-${lifeDigest([step.id]).slice(0, 40)}`,
			lifeRevision: base.state.lifeRevision,
			payload,
			payloadDigest: lifeDigest(payload),
		});
	} else if (step.models.some((r) => r.prepared.request.lane === "reflection"))
		throw Error("Quiet or extension cannot have reflections");
	// Check the resulting LIFE state and future numerical inputs before accepting any mutation.
	const next = observation(base, step);
	assertLifeEventWeights({
		...step.source,
		life: next.life,
		autonomy: base.state,
	});
	return {
		version: 1,
		stepId: step.id,
		kind: base.kind,
		commit: base.commit,
		nextState: parseAutonomyState(base.state),
	};
}
