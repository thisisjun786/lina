import type {
	AgentReference,
	DeclarativeRule,
	Expression,
	LoreEntry,
	RuleEffect,
	Scalar,
	TextPart,
} from "./authoring-types.ts";
import {
	array,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	keyed,
} from "./life-json.ts";
import { parseDisclosurePolicy } from "./life-record-validation.ts";
import { fields, text } from "./validation.ts";

// Protocol safety ceilings; execution budgets remain explicit caller input.
export const MAX_EXPRESSION_DEPTH = 24;
export const MAX_EVALUATION_OPERATIONS = 65_536;
export function authoringText(value: unknown, empty = false): string {
	text(value, "authoring text", empty);
	return value;
}
export function scalar(value: unknown): Scalar {
	if (typeof value === "number") return finite(value);
	if (typeof value === "boolean") return value;
	return authoringText(value, true);
}
export function probability(value: unknown): number {
	const result = finite(value);
	if (result < 0 || result > 1) throw Error("Invalid authoring probability");
	return result;
}
export function parseExpression(value: unknown, depth = 0): Expression {
	if (depth > MAX_EXPRESSION_DEPTH)
		throw Error("Authoring expression depth exceeded");
	if (!value || typeof value !== "object" || !("op" in value))
		throw Error("Invalid authoring expression");
	const child = (item: unknown) => parseExpression(item, depth + 1);
	switch (value.op) {
		case "literal":
			fields(value, ["op", "value"]);
			return { op: "literal", value: scalar(value.value) };
		case "read":
			fields(value, ["op", "variableId"]);
			return { op: "read", variableId: identifier(value.variableId) };
		case "random": {
			fields(value, ["op", "id", "min", "max"]);
			const min = finite(value.min);
			const max = finite(value.max);
			if (min > max) throw Error("Invalid authoring random bounds");
			return { op: "random", id: identifier(value.id), min, max };
		}
		case "not":
			fields(value, ["op", "value"]);
			return { op: "not", value: child(value.value) };
		case "all":
		case "any": {
			const op = value.op;
			fields(value, ["op", "items"]);
			return { op, items: array(value.items, child) };
		}
		case "eq":
		case "ne":
		case "lt":
		case "lte":
		case "gt":
		case "gte":
		case "add":
		case "sub":
		case "mul":
		case "div": {
			const op = value.op;
			fields(value, ["op", "left", "right"]);
			return { op, left: child(value.left), right: child(value.right) };
		}
		default:
			throw Error("Unsupported authoring expression opcode");
	}
}
export function parseTextParts(value: unknown): TextPart[] {
	return array(value, (item) => {
		if (!item || typeof item !== "object" || !("kind" in item))
			throw Error("Invalid authoring text part");
		switch (item.kind) {
			case "text":
				fields(item, ["kind", "text"]);
				return { kind: "text", text: authoringText(item.text, true) };
			case "value":
				fields(item, ["kind", "expression"]);
				return { kind: "value", expression: parseExpression(item.expression) };
			default:
				throw Error("Unsupported authoring text part");
		}
	});
}
export function parseAgentReference(value: unknown): AgentReference {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid authoring agent reference");
	switch (value.kind) {
		case "actor":
		case "target": {
			const kind = value.kind;
			fields(value, ["kind"]);
			return { kind };
		}
		case "agent":
			fields(value, ["kind", "agentId"]);
			return { kind: "agent", agentId: identifier(value.agentId) };
		default:
			throw Error("Unsupported authoring agent reference");
	}
}
export function parseRuleEffect(value: unknown): RuleEffect {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid authoring effect");
	switch (value.kind) {
		case "assign":
			fields(value, ["kind", "variableId", "value"]);
			return {
				kind: "assign",
				variableId: identifier(value.variableId),
				value: parseExpression(value.value),
			};
		case "event":
			fields(value, ["kind", "familyId", "actorIds", "summary"]);
			return {
				kind: "event",
				familyId: identifier(value.familyId),
				actorIds: array(value.actorIds, parseAgentReference),
				summary: parseTextParts(value.summary),
			};
		case "fact":
			fields(value, ["kind", "id", "text", "knownTo"]);
			return {
				kind: "fact",
				id: identifier(value.id),
				text: parseTextParts(value.text),
				knownTo: array(value.knownTo, parseAgentReference),
			};
		case "attitude":
			fields(value, ["kind", "from", "to", "axisId", "delta"]);
			return {
				kind: "attitude",
				from: parseAgentReference(value.from),
				to: parseAgentReference(value.to),
				axisId: identifier(value.axisId),
				delta: parseExpression(value.delta),
			};
		case "goal":
			fields(value, ["kind", "agent", "id", "description"]);
			return {
				kind: "goal",
				agent: parseAgentReference(value.agent),
				id: identifier(value.id),
				description: parseTextParts(value.description),
			};
		default:
			throw Error("Unsupported authoring effect opcode");
	}
}
export function parseDeclarativeRule(value: unknown): DeclarativeRule {
	fields(value, [
		"id",
		"condition",
		"probability",
		"priority",
		"knownTo",
		"effects",
	]);
	return {
		id: identifier(value.id),
		condition: parseExpression(value.condition),
		probability: probability(value.probability),
		priority: finite(value.priority),
		knownTo: identifiers(value.knownTo),
		effects: array(value.effects, parseRuleEffect),
	};
}
export function parseLoreEntry(value: unknown): LoreEntry {
	fields(value, [
		"id",
		"sourceId",
		"primaryKeys",
		"secondaryKeys",
		"secondaryMode",
		"always",
		"recursive",
		"condition",
		"probability",
		"priority",
		"placement",
		"text",
		"disclosure",
		"effects",
	]);
	return {
		id: identifier(value.id),
		sourceId: identifier(value.sourceId),
		primaryKeys: keyed(
			array(value.primaryKeys, (item) => authoringText(item)),
			(x) => x,
		),
		secondaryKeys: keyed(
			array(value.secondaryKeys, (item) => authoringText(item)),
			(x) => x,
		),
		secondaryMode: enumeration(value.secondaryMode, ["any", "all"]),
		always: flag(value.always),
		recursive: flag(value.recursive),
		condition: parseExpression(value.condition),
		probability: probability(value.probability),
		priority: finite(value.priority),
		placement: enumeration(value.placement, ["before", "after"]),
		text: parseTextParts(value.text),
		disclosure: parseDisclosurePolicy(value.disclosure),
		effects: array(value.effects, parseRuleEffect),
	};
}
