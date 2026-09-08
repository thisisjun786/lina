import type { WorldPack } from "./authoring-types.ts";
import {
	array,
	enumeration,
	identifier,
	jsonBoundary,
	keyed,
} from "./life-json.ts";
import { fields } from "./validation.ts";
import type { WorkConfig, WorkInfluenceRule } from "./work-types.ts";

export function parseWorkConfig(value: unknown): WorkConfig {
	jsonBoundary(value);
	fields(value, ["rules"]);
	return {
		rules: keyed(
			array(value.rules, (input): WorkInfluenceRule => {
				fields(input, [
					"id",
					"familyId",
					"categoryId",
					"outcomes",
					"attribution",
					"weight",
					"requiredMatch",
				]);
				if (
					typeof input.weight !== "number" ||
					!Number.isFinite(input.weight) ||
					typeof input.requiredMatch !== "boolean"
				)
					throw Error("Invalid work influence rule");
				const outcomes = array(input.outcomes, (outcome) =>
					enumeration(outcome, [
						"turn_ended",
						"verified_result",
						"failed",
						"interrupted",
					]),
				);
				if (new Set(outcomes).size !== outcomes.length)
					throw Error("Duplicate work outcome filter");
				return {
					id: identifier(input.id),
					familyId: identifier(input.familyId),
					categoryId: identifier(input.categoryId),
					outcomes,
					attribution: enumeration(input.attribution, ["owner", "participant"]),
					weight: input.weight,
					requiredMatch: input.requiredMatch,
				};
			}),
			(rule) => rule.id,
		),
	};
}

export function assertWorkConfigReferences(
	config: WorkConfig,
	pack: WorldPack | null,
): void {
	if (
		!pack ||
		config.rules.some(
			(rule) =>
				!pack.eventFamilies.some((family) => family.id === rule.familyId),
		)
	)
		throw Error("Unknown work event family");
}
