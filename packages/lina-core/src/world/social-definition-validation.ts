import { authoringText } from "./authoring-node-validation.ts";
import {
	array,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	nullableId,
	revision,
} from "./life-json.ts";
import type {
	SocialAction,
	SocialBinding,
	SocialCapability,
	SocialCondition,
	SocialDefinition,
	SocialInfluence,
	SocialPredicateEffect,
	SocialPredicatePolicy,
	SocialReference,
	SocialTriggerRule,
	SocialVolitionRule,
} from "./social-types.ts";
import { fields, integer } from "./validation.ts";

export const SOCIAL_PRIMITIVES = [
	"move",
	"attempt",
	"transfer",
	"reveal",
	"goal",
] as const;
export function socialValue(value: unknown): number | boolean {
	return typeof value === "boolean" ? value : finite(value);
}
export function parseSocialReference(value: unknown): SocialReference {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid social reference");
	const kind = enumeration(value.kind, ["actor", "target", "agent", "binding"]);
	if (kind === "agent") {
		fields(value, ["kind", "agentId"]);
		return { kind, agentId: identifier(value.agentId) };
	}
	if (kind === "binding") {
		fields(value, ["kind", "id"]);
		return { kind, id: identifier(value.id) };
	}
	fields(value, ["kind"]);
	return { kind };
}
function binding(value: unknown): SocialBinding {
	fields(value, ["id", "roleId", "agentId"]);
	const result = {
		id: identifier(value.id),
		roleId: nullableId(value.roleId),
		agentId: nullableId(value.agentId),
	};
	if (
		["actor", "target"].includes(result.id) ||
		(!result.roleId && !result.agentId)
	)
		throw Error("Invalid social binding");
	return result;
}
export function parseSocialCondition(value: unknown): SocialCondition {
	fields(value, [
		"predicateId",
		"first",
		"second",
		"operator",
		"value",
		"window",
	]);
	let window: SocialCondition["window"] = null;
	if (value.window !== null) {
		fields(value.window, ["mostRecent", "leastRecent"]);
		integer(value.window.mostRecent, "social window", 0, 4095);
		integer(
			value.window.leastRecent,
			"social window",
			value.window.mostRecent,
			4095,
		);
		window = {
			mostRecent: value.window.mostRecent,
			leastRecent: value.window.leastRecent,
		};
	}
	return {
		predicateId: identifier(value.predicateId),
		first: parseSocialReference(value.first),
		second: value.second === null ? null : parseSocialReference(value.second),
		operator: enumeration(value.operator, ["=", ">", "<"]),
		value: socialValue(value.value),
		window,
	};
}
export function parseSocialPredicateEffect(
	value: unknown,
): SocialPredicateEffect {
	fields(value, ["predicateId", "first", "second", "operator", "value"]);
	return {
		predicateId: identifier(value.predicateId),
		first: parseSocialReference(value.first),
		second: value.second === null ? null : parseSocialReference(value.second),
		operator: enumeration(value.operator, ["=", "+", "-"]),
		value: socialValue(value.value),
	};
}
export function parseSocialPolicy(value: unknown): SocialPredicatePolicy {
	fields(value, [
		"predicateId",
		"duration",
		"visibility",
		"resource",
		"attitudeAxisId",
	]);
	const visibility = value.visibility;
	if (!visibility || typeof visibility !== "object" || !("kind" in visibility))
		throw Error("Invalid social visibility");
	const kind = enumeration(visibility.kind, ["public", "first", "agents"]);
	fields(visibility, kind === "agents" ? ["kind", "agentIds"] : ["kind"]);
	const duration = value.duration === null ? null : revision(value.duration, 1);
	if (duration !== null && duration > 4096)
		throw Error("Social duration capacity exceeded");
	return {
		predicateId: identifier(value.predicateId),
		duration,
		visibility:
			kind === "agents"
				? { kind, agentIds: identifiers(visibility.agentIds) }
				: { kind },
		resource: flag(value.resource),
		attitudeAxisId: nullableId(value.attitudeAxisId),
	};
}
function influence(value: unknown): SocialInfluence {
	fields(value, ["conditions", "weight"]);
	return {
		conditions: array(value.conditions, parseSocialCondition),
		weight: finite(value.weight),
	};
}
function action(value: unknown): SocialAction {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid social action");
	const kind = enumeration(value.kind, ["root", "group", "terminal"]);
	const baseFields = [
		"id",
		"kind",
		"bindings",
		"conditions",
		"influence",
	] as const;
	fields(
		value,
		kind === "root"
			? ([...baseFields, "intent", "children"] as const)
			: kind === "group"
				? ([...baseFields, "children"] as const)
				: ([...baseFields, "acceptance", "effects"] as const),
	);
	const base = {
		id: identifier(value["id"]),
		bindings: keyed(array(value["bindings"], binding), (b) => b.id),
		conditions: array(value["conditions"], parseSocialCondition),
		influence: array(value["influence"], influence),
	};
	if (kind === "terminal")
		return {
			...base,
			kind,
			acceptance: enumeration(value["acceptance"], [
				"accepted",
				"rejected",
				"either",
			]),
			effects: array(value["effects"], parseSocialPredicateEffect),
		};
	const children = identifiers(value["children"]);
	if (!children.length) throw Error("Social action requires children");
	if (kind === "group") return { ...base, kind, children };
	const intent = value["intent"];
	fields(intent, ["predicateId", "intentType"]);
	return {
		...base,
		kind,
		children,
		intent: {
			predicateId: identifier(intent.predicateId),
			intentType: flag(intent.intentType),
		},
	};
}
function trigger(value: unknown): SocialTriggerRule {
	fields(value, ["id", "bindings", "conditions", "effects"]);
	return {
		id: identifier(value.id),
		bindings: keyed(array(value.bindings, binding), (b) => b.id),
		conditions: array(value.conditions, parseSocialCondition),
		effects: array(value.effects, parseSocialPredicateEffect),
	};
}
function volition(value: unknown): SocialVolitionRule {
	fields(value, ["id", "bindings", "conditions", "effects"]);
	return {
		id: identifier(value.id),
		bindings: keyed(array(value.bindings, binding), (b) => b.id),
		conditions: array(value.conditions, parseSocialCondition),
		effects: array(value.effects, (item) => {
			fields(item, ["predicateId", "first", "second", "intentType", "weight"]);
			return {
				predicateId: identifier(item.predicateId),
				first: parseSocialReference(item.first),
				second: item.second === null ? null : parseSocialReference(item.second),
				intentType: flag(item.intentType),
				weight: finite(item.weight),
			};
		}),
	};
}
function capability(value: unknown): SocialCapability {
	fields(value, [
		"id",
		"description",
		"actorRoleIds",
		"targetRoleIds",
		"knownTo",
		"primitives",
		"rootActionId",
		"conditions",
	]);
	return {
		id: identifier(value.id),
		description: authoringText(value.description),
		actorRoleIds: identifiers(value.actorRoleIds),
		targetRoleIds: identifiers(value.targetRoleIds),
		knownTo: identifiers(value.knownTo),
		primitives: keyed(
			array(value.primitives, (p) => enumeration(p, SOCIAL_PRIMITIVES)),
			(p) => p,
		),
		rootActionId: nullableId(value.rootActionId),
		conditions: array(value.conditions, parseSocialCondition),
	};
}
export function parseSocialDefinition(value: unknown): SocialDefinition {
	jsonBoundary(value);
	fields(value, [
		"version",
		"policies",
		"triggers",
		"volitions",
		"actions",
		"capabilities",
	]);
	if (value.version !== 1) throw Error("Unsupported social definition version");
	return {
		version: 1,
		policies: keyed(
			array(value.policies, parseSocialPolicy),
			(p) => p.predicateId,
		),
		triggers: keyed(array(value.triggers, trigger), (r) => r.id),
		volitions: keyed(array(value.volitions, volition), (r) => r.id),
		actions: keyed(array(value.actions, action), (a) => a.id),
		capabilities: keyed(array(value.capabilities, capability), (c) => c.id),
	};
}
