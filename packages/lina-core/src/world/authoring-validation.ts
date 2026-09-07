import {
	authoringText,
	parseDeclarativeRule,
	parseExpression,
	parseLoreEntry,
	parseRuleEffect,
	scalar,
} from "./authoring-node-validation.ts";
import { validateWorldSemantics } from "./authoring-semantics.ts";
import type {
	PredicateDefinition,
	VariableDefinition,
	WorldDraftPatch,
	WorldPack,
} from "./authoring-types.ts";
import {
	array,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	revision,
} from "./life-json.ts";
import { parseLifeDefinition } from "./life-validation.ts";
import { fields, parseDefinition } from "./validation.ts";

export {
	parseEvaluationInput,
	parseEvaluationLimits,
	parseLifeConfigInput,
	parseWorldConfirmation,
	parseWorldDraftCursor,
	parseWorldDraftInput,
	parseWorldPreviewOptions,
	parseWorldSuggestionRequest,
} from "./authoring-request-validation.ts";

function nullableText(value: unknown): string | null {
	return value === null ? null : authoringText(value, true);
}
function bounds(
	type: string,
	min: unknown,
	max: unknown,
): { min: number | null; max: number | null } {
	const result = {
		min: min === null ? null : finite(min),
		max: max === null ? null : finite(max),
	};
	if (
		type === "number"
			? result.min !== null && result.max !== null && result.min > result.max
			: result.min !== null || result.max !== null
	)
		throw Error("Invalid authoring variable bounds");
	return result;
}
function variable(value: unknown): VariableDefinition {
	fields(value, ["id", "type", "initial", "min", "max", "knownTo"]);
	const type = enumeration(value.type, ["string", "number", "boolean"]);
	return {
		id: identifier(value.id),
		type,
		initial: scalar(value.initial),
		...bounds(type, value.min, value.max),
		knownTo: identifiers(value.knownTo),
	};
}
function predicate(value: unknown): PredicateDefinition {
	fields(value, ["id", "type", "direction", "initial", "min", "max"]);
	const type = enumeration(value.type, ["number", "boolean"]);
	const range = bounds(type, value.min, value.max);
	const initial =
		type === "number" ? finite(value.initial) : flag(value.initial);
	if (
		typeof initial === "number" &&
		((range.min !== null && initial < range.min) ||
			(range.max !== null && initial > range.max))
	)
		throw Error("Invalid authoring predicate initial");
	return {
		id: identifier(value.id),
		type,
		direction: enumeration(value.direction, [
			"directed",
			"reciprocal",
			"undirected",
		]),
		initial,
		...range,
	};
}
export function parseWorldPack(value: unknown): WorldPack {
	jsonBoundary(value);
	fields(value, [
		"schemaVersion",
		"worldId",
		"version",
		"background",
		"world",
		"life",
		"constraints",
		"roles",
		"variables",
		"predicates",
		"lore",
		"rules",
		"eventFamilies",
		"unresolved",
		"importReport",
	]);
	if (value.schemaVersion !== 1)
		throw Error("Unsupported authoring schema version");
	fields(value.background, [
		"authoredText",
		"era",
		"environment",
		"description",
	]);
	const pack: WorldPack = {
		schemaVersion: 1,
		worldId: identifier(value.worldId),
		version: revision(value.version, 1),
		background: {
			authoredText: authoringText(value.background.authoredText),
			era: nullableText(value.background.era),
			environment: nullableText(value.background.environment),
			description: nullableText(value.background.description),
		},
		world: parseDefinition(value.world),
		life: parseLifeDefinition(value.life),
		constraints: keyed(
			array(value.constraints, (item) => {
				fields(item, ["id", "description", "condition"]);
				return {
					id: identifier(item.id),
					description: authoringText(item.description),
					condition: parseExpression(item.condition),
				};
			}),
			(x) => x.id,
		),
		roles: keyed(
			array(value.roles, (item) => {
				fields(item, ["agentId", "roleId", "description", "status"]);
				return {
					agentId: identifier(item.agentId),
					roleId: identifier(item.roleId),
					description: authoringText(item.description, true),
					status: enumeration(item.status, ["active", "retired"]),
				};
			}),
			(x) => x.agentId,
		),
		variables: keyed(array(value.variables, variable), (x) => x.id),
		predicates: keyed(array(value.predicates, predicate), (x) => x.id),
		lore: keyed(array(value.lore, parseLoreEntry), (x) => x.id),
		rules: keyed(array(value.rules, parseDeclarativeRule), (x) => x.id),
		eventFamilies: keyed(
			array(value.eventFamilies, (item) => {
				fields(item, [
					"id",
					"description",
					"actorRoleIds",
					"condition",
					"weight",
					"effects",
				]);
				const weight = finite(item.weight);
				if (weight < 0) throw Error("Invalid authoring event weight");
				return {
					id: identifier(item.id),
					description: authoringText(item.description),
					actorRoleIds: identifiers(item.actorRoleIds),
					condition: parseExpression(item.condition),
					weight,
					effects: array(item.effects, parseRuleEffect),
				};
			}),
			(x) => x.id,
		),
		unresolved: keyed(
			array(value.unresolved, (item) => {
				fields(item, ["id", "question", "blocking"]);
				return {
					id: identifier(item.id),
					question: authoringText(item.question),
					blocking: flag(item.blocking),
				};
			}),
			(x) => x.id,
		),
		importReport: array(value.importReport, (item) => {
			fields(item, ["sourceId", "reason", "rawJson"]);
			const rawJson = authoringText(item.rawJson);
			jsonBoundary(JSON.parse(rawJson));
			return {
				sourceId: identifier(item.sourceId),
				reason: authoringText(item.reason),
				rawJson,
			};
		}),
	};
	validateWorldSemantics(pack);
	return pack;
}
export function parseWorldDraftPatch(value: unknown): WorldDraftPatch {
	jsonBoundary(value);
	fields(value, ["authoredText", "pack"]);
	return {
		authoredText: authoringText(value.authoredText),
		pack: value.pack === null ? null : parseWorldPack(value.pack),
	};
}
