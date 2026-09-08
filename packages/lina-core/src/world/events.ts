import {
	assertAutonomySource,
	autonomyEvaluationInput,
} from "./autonomy-source.ts";
import type {
	AutonomousEventPolicy,
	AutonomySource,
	EventCandidate,
	EventDecision,
} from "./autonomy-types.ts";
import { assertAutonomyPack } from "./autonomy-validation.ts";
import {
	finite,
	identifier,
	lifeDigest,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import { createEvaluationContext, evaluateExpression } from "./rules.ts";
import { workContributions, workEligible } from "./work-selection.ts";

type WeightSource = Pick<AutonomySource, "pack" | "life" | "autonomy"> &
	Partial<Pick<AutonomySource, "work" | "config">>;

function candidate(
	source: WeightSource,
	policy: AutonomousEventPolicy,
	agentId: string,
): EventCandidate {
	const family = source.pack.eventFamilies.find(
		(x) => x.id === policy.familyId,
	);
	if (!family) throw Error("Unknown autonomy event family");
	const contributions: EventCandidate["contributions"] = [
		{ kind: "base", id: family.id, value: family.weight },
	];
	for (const term of policy.needWeights) {
		const row = source.autonomy.needs.find(
			(x) => x.agentId === agentId && x.needId === term.needId,
		);
		if (!row) throw Error("Missing autonomy need state");
		contributions.push({
			kind: "need",
			id: term.needId,
			value: finite(row.value * term.multiplier),
		});
	}
	for (const goal of source.autonomy.goals
		.filter(
			(x) =>
				x.agentId === agentId &&
				x.status === "active" &&
				x.familyIds.includes(family.id),
		)
		.sort((a, b) => (a.id < b.id ? -1 : 1)))
		contributions.push({
			kind: "goal",
			id: goal.id,
			value: finite(goal.priority * (1 - goal.progress) * policy.goalWeight),
		});
	for (const term of policy.traitWeights) {
		const row = source.life.traits.find(
			(x) => x.agentId === agentId && x.axisId === term.axisId,
		);
		if (!row) throw Error("Missing autonomy trait state");
		contributions.push({
			kind: "trait",
			id: term.axisId,
			value: finite(row.value * term.multiplier),
		});
	}
	for (const term of policy.habitWeights) {
		const row = source.life.habits.find(
			(x) => x.agentId === agentId && x.habitId === term.habitId,
		);
		if (!row) throw Error("Missing autonomy habit state");
		contributions.push({
			kind: "habit",
			id: term.habitId,
			value: row.value === term.when ? term.weight : 0,
		});
	}
	const prior = source.autonomy.families.find(
		(x) => x.agentId === agentId && x.familyId === family.id,
	);
	contributions.push({
		kind: "novelty",
		id: family.id,
		value: finite(-(prior?.count ?? 0) * policy.noveltyPenalty),
	});
	if (source.config)
		contributions.push(
			...workContributions(
				{ ...source, config: source.config },
				family.id,
				agentId,
			),
		);
	return {
		id: `candidate-${lifeDigest([family.id, agentId]).slice(0, 40)}`,
		familyId: family.id,
		agentId,
		weight: Math.max(
			0,
			contributions.reduce((sum, x) => finite(sum + x.value), 0),
		),
		contributions,
	};
}
/** Admission checks every role-compatible weight, including opportunities hidden by cooldowns. */
export function assertLifeEventWeights(source: WeightSource): void {
	const roles = source.pack.roles.filter((role) => role.status === "active");
	if (roles.length * source.pack.autonomy.events.length > MAX_LIFE_ITEMS)
		throw Error("Autonomy candidate capacity exceeded");
	let total = finite(source.pack.autonomy.quietWeight);
	for (const policy of source.pack.autonomy.events) {
		const family = source.pack.eventFamilies.find(
			(row) => row.id === policy.familyId,
		);
		if (!family) throw Error("Unknown autonomy event family");
		for (const role of roles) {
			if (!family.actorRoleIds.includes(role.roleId)) continue;
			total = finite(total + candidate(source, policy, role.agentId).weight);
		}
	}
}
/** Private eligibility and diagnostics never form part of a model perception. */
export function selectLifeEvent(
	source: AutonomySource,
	stepId: string,
): EventDecision {
	identifier(stepId);
	assertAutonomyPack(source.pack);
	assertAutonomySource(source);
	assertLifeEventWeights(source);
	if (!source.config.clock || !source.config.limits)
		throw Error("Autonomy clock or limits unconfigured");
	const { pack, autonomy } = source,
		limits = source.config.limits;
	const roles = pack.roles
		.filter((x) => x.status === "active")
		.sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
	if (roles.length * pack.autonomy.events.length > MAX_LIFE_ITEMS)
		throw Error("Autonomy candidate capacity exceeded");
	const candidates: EventCandidate[] = [];
	const queued = autonomy.pendingEvents
		.filter((x) => x.status === "pending" && x.depth <= limits.maxCausalDepth)
		.sort((a, b) => (a.id < b.id ? -1 : 1));
	for (const policy of [...pack.autonomy.events].sort((a, b) =>
		a.familyId < b.familyId ? -1 : 1,
	))
		for (const role of roles) {
			const family = pack.eventFamilies.find((x) => x.id === policy.familyId);
			if (!family) throw Error("Unknown autonomy event family");
			if (
				!family.actorRoleIds.includes(role.roleId) ||
				!source.world.scenes.some((x) => x.occupants.includes(role.agentId))
			)
				continue;
			const prior = autonomy.families.find(
				(x) => x.familyId === family.id && x.agentId === role.agentId,
			);
			if (
				prior &&
				autonomy.stepNumber - prior.lastStepNumber < policy.cooldownSteps
			)
				continue;
			const available = pack.social.capabilities.some(
				(c) =>
					policy.capabilityIds.includes(c.id) &&
					c.knownTo.includes(role.agentId) &&
					c.actorRoleIds.includes(role.roleId) &&
					(!c.targetRoleIds.length ||
						roles.some(
							(t) =>
								t.agentId !== role.agentId &&
								c.targetRoleIds.includes(t.roleId),
						)),
			);
			if (!available) continue;
			const context = createEvaluationContext(
				pack,
				autonomyEvaluationInput(source, stepId, role.agentId),
			);
			// Authoritative eligibility may inspect hidden conditions; the receipt remains private.
			context.variables = Object.freeze({ ...autonomy.variables });
			if (
				pack.constraints.some(
					(x) =>
						evaluateExpression(x.condition, context, `constraint:${x.id}`) !==
						true,
				) ||
				evaluateExpression(family.condition, context, `family:${family.id}`) !==
					true
			)
				continue;
			if (!workEligible(source, family.id, role.agentId)) continue;
			candidates.push(candidate(source, policy, role.agentId));
		}
	// A queued causal opportunity still passes the same authored eligibility and weighting gates.
	const parent =
		queued.find((q) =>
			candidates.some(
				(c) =>
					c.familyId === q.familyId &&
					q.actorIds.includes(c.agentId) &&
					c.weight > 0,
			),
		) ?? null;
	const eligible = parent
		? candidates.filter(
				(c) =>
					c.familyId === parent.familyId && parent.actorIds.includes(c.agentId),
			)
		: candidates;
	const sum = eligible.reduce(
		(n, c) => finite(n + c.weight),
		pack.autonomy.quietWeight,
	);
	const value =
		Number.parseInt(
			lifeDigest([
				"autonomy-selection-v1",
				pack.worldId,
				autonomy.seed,
				autonomy.selectionIndex,
				stepId,
			]).slice(0, 13),
			16,
		) / 0x10000000000000;
	let cursor = value * sum,
		chosen: EventCandidate | undefined;
	for (const c of eligible) {
		cursor -= c.weight;
		if (cursor < 0) {
			chosen = c;
			break;
		}
	}
	const castSize = new Set([
		...pack.world.agents,
		...pack.roles.map((r) => r.agentId),
	]).size;
	const calls = chosen ? 2 + (castSize > 1 ? 1 : 0) + castSize : 0;
	if (calls > limits.maxModelCalls)
		throw Error(
			`Autonomy model call budget requires ${calls}, configured ${limits.maxModelCalls}`,
		);
	return {
		version: 1,
		stepId,
		kind: chosen ? "event" : "quiet",
		familyId: chosen?.familyId ?? null,
		agentId: chosen?.agentId ?? null,
		simulationTime: revision(
			source.world.simulationTime + source.config.clock.stepSize,
		),
		candidates,
		random: { seed: autonomy.seed, index: autonomy.selectionIndex, value },
		parent: chosen ? parent : null,
		maxModelCalls: calls,
	};
}
