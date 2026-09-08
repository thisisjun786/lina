import { authoringText } from "./authoring-node-validation.ts";
import type { RuleEffect, WorldPackV3 } from "./authoring-types.ts";
import type {
	AutonomyDefinition,
	GoalDefinition,
	NeedDefinition,
} from "./autonomy-types.ts";
import {
	array,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import { fields } from "./validation.ts";

export { parseReflectionProposal } from "./autonomy-reflection-validation.ts";
export { parseAutonomyState } from "./autonomy-state-validation.ts";

export function nonnegative(value: unknown): number {
	const n = finite(value);
	if (n < 0) throw Error("Negative autonomy weight");
	return n;
}
export function unitInterval(value: unknown): number {
	const n = nonnegative(value);
	if (n > 1) throw Error("Autonomy progress outside bounds");
	return n;
}
export function parseNeedDefinition(value: unknown): NeedDefinition {
	fields(value, ["id", "label", "min", "max", "initial", "driftPerStep"]);
	const min = finite(value.min),
		max = finite(value.max),
		initial = finite(value.initial);
	if (min >= max || initial < min || initial > max)
		throw Error("Invalid autonomy need bounds");
	return {
		id: identifier(value.id),
		label: authoringText(value.label),
		min,
		max,
		initial,
		driftPerStep: finite(value.driftPerStep),
	};
}
export function parseGoalDefinition(value: unknown): GoalDefinition {
	fields(value, ["id", "agentId", "description", "priority", "familyIds"]);
	return {
		id: identifier(value.id),
		agentId: identifier(value.agentId),
		description: authoringText(value.description),
		priority: nonnegative(value.priority),
		familyIds: identifiers(value.familyIds),
	};
}
export function parseAutonomyDefinition(value: unknown): AutonomyDefinition {
	jsonBoundary(value);
	fields(value, [
		"version",
		"needs",
		"goals",
		"events",
		"quietWeight",
		"growth",
	]);
	if (value.version !== 1) throw Error("Unsupported autonomy version");
	fields(value.growth, ["maxNumericDelta", "minHabitExperiences"]);
	return {
		version: 1,
		needs: keyed(array(value.needs, parseNeedDefinition), (x) => x.id),
		goals: keyed(array(value.goals, parseGoalDefinition), (x) => x.id),
		events: keyed(
			array(value.events, (v) => {
				fields(v, [
					"familyId",
					"capabilityIds",
					"cooldownSteps",
					"noveltyPenalty",
					"goalWeight",
					"needWeights",
					"traitWeights",
					"habitWeights",
				]);
				return {
					familyId: identifier(v.familyId),
					capabilityIds: identifiers(v.capabilityIds),
					cooldownSteps: revision(v.cooldownSteps),
					noveltyPenalty: nonnegative(v.noveltyPenalty),
					goalWeight: nonnegative(v.goalWeight),
					needWeights: keyed(
						array(v.needWeights, (t) => {
							fields(t, ["needId", "multiplier"]);
							return {
								needId: identifier(t.needId),
								multiplier: finite(t.multiplier),
							};
						}),
						(x) => x.needId,
					),
					traitWeights: keyed(
						array(v.traitWeights, (t) => {
							fields(t, ["axisId", "multiplier"]);
							return {
								axisId: identifier(t.axisId),
								multiplier: finite(t.multiplier),
							};
						}),
						(x) => x.axisId,
					),
					habitWeights: keyed(
						array(v.habitWeights, (t) => {
							fields(t, ["habitId", "when", "weight"]);
							return {
								habitId: identifier(t.habitId),
								when: flag(t.when),
								weight: finite(t.weight),
							};
						}),
						(x) => x.habitId,
					),
				};
			}),
			(x) => x.familyId,
		),
		quietWeight: nonnegative(value.quietWeight),
		growth: {
			maxNumericDelta: nonnegative(value.growth.maxNumericDelta),
			minHabitExperiences: revision(value.growth.minHabitExperiences, 1),
		},
	};
}
/** Pack parser owns common grammar; this validates cross-references and finite autonomous expansions. */
export function assertAutonomyPack(pack: WorldPackV3): void {
	const d = parseAutonomyDefinition(pack.autonomy),
		cast = pack.roles.length;
	if (
		[
			cast * d.needs.length,
			cast * d.events.length,
			cast * pack.eventFamilies.length,
		].some((n) => n > MAX_LIFE_ITEMS)
	)
		throw Error("Autonomy capacity exceeded");
	const familyIds = new Set(pack.eventFamilies.map((x) => x.id));
	for (const goal of d.goals)
		if (
			!pack.roles.some((x) => x.agentId === goal.agentId) ||
			goal.familyIds.some((id) => !familyIds.has(id))
		)
			throw Error("Unknown autonomy goal reference");
	let total = d.quietWeight;
	for (const e of d.events) {
		const family = pack.eventFamilies.find((x) => x.id === e.familyId);
		if (
			!family ||
			!e.capabilityIds.length ||
			e.capabilityIds.some(
				(id) => !pack.social.capabilities.some((x) => x.id === id),
			)
		)
			throw Error("Unknown autonomy family or capability");
		let bound = nonnegative(family.weight);
		for (const w of e.needWeights) {
			const n = d.needs.find((x) => x.id === w.needId);
			if (!n) throw Error("Unknown autonomy need");
			bound = finite(
				bound +
					Math.max(
						Math.abs(n.min * w.multiplier),
						Math.abs(n.max * w.multiplier),
					),
			);
		}
		for (const w of e.traitWeights) {
			const n = pack.life.traits.find((x) => x.id === w.axisId);
			if (!n) throw Error("Unknown autonomy trait");
			bound = finite(
				bound +
					Math.max(
						Math.abs(n.min * w.multiplier),
						Math.abs(n.max * w.multiplier),
					),
			);
		}
		for (const w of e.habitWeights) {
			if (!pack.life.habits.some((x) => x.id === w.habitId))
				throw Error("Unknown autonomy habit");
			bound = finite(bound + Math.abs(w.weight));
		}
		for (const g of d.goals.filter((x) => x.familyIds.includes(e.familyId)))
			bound = finite(bound + g.priority * e.goalWeight);
		total = finite(total + bound * cast);
	}
	const mapped = new Set(
		pack.social.policies.flatMap((p) =>
			p.attitudeAxisId === null ? [] : [p.attitudeAxisId],
		),
	);
	const check = (effects: RuleEffect[]) => {
		for (const e of effects)
			if (e.kind === "attitude" && mapped.has(e.axisId))
				throw Error("Autonomy rule conflicts with mapped social attitude");
	};
	for (const r of [...pack.rules, ...pack.lore, ...pack.eventFamilies])
		check(r.effects);
}
