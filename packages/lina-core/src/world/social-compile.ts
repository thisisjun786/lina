import { scalar } from "./authoring-node-validation.ts";
import type { SocialWorldPack } from "./authoring-types.ts";
import {
	array,
	digest,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { parseLifeDefinition } from "./life-validation.ts";
import {
	parseSocialDefinition,
	parseSocialPolicy,
	socialValue,
} from "./social-definition-validation.ts";
import { assertCompiledSocialSemantics } from "./social-semantics.ts";
import type {
	CompiledSocialPack,
	CompiledSocialPredicate,
} from "./social-types.ts";
import { fields } from "./validation.ts";

function hashes(
	base: Omit<
		CompiledSocialPack,
		"digest" | "schemaDigest" | "ruleDigest" | "actionDigest"
	>,
): CompiledSocialPack {
	const schemaDigest = lifeDigest({
		predicates: base.predicates,
		variables: base.variables,
	});
	const ruleDigest = lifeDigest({
		triggers: base.definition.triggers,
		volitions: base.definition.volitions,
	});
	const actionDigest = lifeDigest({
		actions: base.definition.actions,
		capabilities: base.definition.capabilities,
	});
	const body = { ...base, schemaDigest, ruleDigest, actionDigest };
	return { ...body, digest: lifeDigest(body) };
}
export function assertSocialPackSemantics(pack: SocialWorldPack): void {
	compileSocialPack(pack);
}
export function compileSocialPack(pack: SocialWorldPack): CompiledSocialPack {
	jsonBoundary(pack);
	if (
		(pack.schemaVersion !== 2 && pack.schemaVersion !== 3) ||
		pack.worldId !== pack.world.id ||
		pack.world.version !== pack.version
	)
		throw Error("Invalid social world pack");
	const definition = parseSocialDefinition(pack.social);
	const predicates = keyed(
		pack.predicates.map((predicate) => {
			const policy = definition.policies.find(
				(p) => p.predicateId === predicate.id,
			);
			if (!policy) throw Error("Missing social predicate policy");
			return { ...structuredClone(predicate), policy };
		}),
		(p) => p.id,
	);
	const result = hashes({
		version: 1,
		compilerRevision: 1,
		worldId: pack.worldId,
		packVersion: pack.version,
		cast: keyed(
			pack.roles.map((r) => ({
				agentId: r.agentId,
				roleId: r.roleId,
				active: r.status === "active",
			})),
			(r) => r.agentId,
		),
		life: structuredClone(pack.life),
		predicates,
		variables: keyed(structuredClone(pack.variables), (v) => v.id),
		definition,
	});
	assertCompiledSocialSemantics(result);
	jsonBoundary(result);
	return result;
}
function predicate(value: unknown): CompiledSocialPredicate {
	fields(value, ["id", "type", "direction", "initial", "min", "max", "policy"]);
	return {
		id: identifier(value.id),
		type: enumeration(value.type, ["number", "boolean"]),
		direction: enumeration(value.direction, [
			"directed",
			"reciprocal",
			"undirected",
		]),
		initial: socialValue(value.initial),
		min: value.min === null ? null : finite(value.min),
		max: value.max === null ? null : finite(value.max),
		policy: parseSocialPolicy(value.policy),
	};
}
export function parseCompiledSocialPack(value: unknown): CompiledSocialPack {
	jsonBoundary(value);
	fields(value, [
		"version",
		"compilerRevision",
		"worldId",
		"packVersion",
		"digest",
		"schemaDigest",
		"ruleDigest",
		"actionDigest",
		"cast",
		"life",
		"predicates",
		"variables",
		"definition",
	]);
	if (value.version !== 1 || value.compilerRevision !== 1)
		throw Error("Unsupported social compiler version");
	const result = hashes({
		version: 1,
		compilerRevision: 1,
		worldId: identifier(value.worldId),
		packVersion: revision(value.packVersion, 1),
		cast: keyed(
			array(value.cast, (item) => {
				fields(item, ["agentId", "roleId", "active"]);
				return {
					agentId: identifier(item.agentId),
					roleId: identifier(item.roleId),
					active: flag(item.active),
				};
			}),
			(c) => c.agentId,
		),
		life: parseLifeDefinition(value.life),
		predicates: keyed(array(value.predicates, predicate), (p) => p.id),
		variables: keyed(
			array(value.variables, (item) => {
				fields(item, ["id", "type", "initial", "min", "max", "knownTo"]);
				return {
					id: identifier(item.id),
					type: enumeration(item.type, ["string", "number", "boolean"]),
					initial: scalar(item.initial),
					min: item.min === null ? null : finite(item.min),
					max: item.max === null ? null : finite(item.max),
					knownTo: identifiers(item.knownTo),
				};
			}),
			(v) => v.id,
		),
		definition: parseSocialDefinition(value.definition),
	});
	assertCompiledSocialSemantics(result);
	for (const key of [
		"digest",
		"schemaDigest",
		"ruleDigest",
		"actionDigest",
	] as const)
		if (digest(value[key]) !== result[key])
			throw Error("Social compiled digest mismatch");
	return result;
}
