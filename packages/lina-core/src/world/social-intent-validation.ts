import { authoringText } from "./authoring-node-validation.ts";
import {
	array,
	finite,
	identifier,
	jsonBoundary,
	nullableId,
} from "./life-json.ts";
import { parseClaimRef } from "./life-record-validation.ts";
import { SOCIAL_PRIMITIVES } from "./social-definition-validation.ts";
import type {
	CompiledSocialPack,
	SocialExtensionIntent,
	SocialIntentInspection,
	SocialPrimitive,
} from "./social-types.ts";
import { fields } from "./validation.ts";

export function inspectSocialIntent(
	value: unknown,
	pack: CompiledSocialPack,
): SocialIntentInspection {
	jsonBoundary(value);
	fields(value, [
		"id",
		"agentId",
		"targetAgentId",
		"capabilityId",
		"description",
		"primitives",
	]);
	const agentId = identifier(value.agentId),
		targetAgentId = nullableId(value.targetAgentId),
		capabilityId = identifier(value.capabilityId);
	const actor = pack.cast.find((c) => c.agentId === agentId && c.active);
	const target = pack.cast.find((c) => c.agentId === targetAgentId && c.active);
	const capability = pack.definition.capabilities.find(
		(c) => c.id === capabilityId,
	);
	if (
		!actor ||
		!capability ||
		!capability.knownTo.includes(agentId) ||
		!capability.actorRoleIds.includes(actor.roleId) ||
		(targetAgentId !== null && (!target || targetAgentId === agentId)) ||
		(capability.targetRoleIds.length &&
			(!target || !capability.targetRoleIds.includes(target.roleId)))
	)
		throw Error("Unavailable social capability");
	const recipient = (value: unknown): string => {
		const id = identifier(value);
		if (id === agentId || !pack.cast.some((c) => c.agentId === id && c.active))
			throw Error("Invalid social recipient");
		return id;
	};
	const primitives = array(
		value.primitives,
		(item): SocialExtensionIntent["primitives"][number] => {
			if (!item || typeof item !== "object" || !("kind" in item))
				throw Error("Invalid social primitive");
			const kind = identifier(item.kind);
			if (!(SOCIAL_PRIMITIVES as readonly string[]).includes(kind)) {
				if (kind === "extension") {
					fields(item, ["kind", "primitiveKind", "proposal"]);
					return {
						kind: "extension",
						primitiveKind: identifier(item.primitiveKind),
						proposal: authoringText(item.proposal),
					};
				}
				fields(item, ["kind", "proposal"]);
				return {
					kind: "extension",
					primitiveKind: kind,
					proposal: authoringText(item.proposal),
				};
			}
			if (!(capability.primitives as readonly string[]).includes(kind))
				throw Error("Social primitive not permitted");
			switch (kind) {
				case "move":
					fields(item, ["kind", "sceneId"]);
					return { kind, sceneId: identifier(item.sceneId) };
				case "attempt":
					fields(item, ["kind", "rootActionId"]);
					if (identifier(item.rootActionId) !== capability.rootActionId)
						throw Error("Social root mismatch");
					return { kind, rootActionId: item.rootActionId as string };
				case "transfer": {
					fields(item, ["kind", "predicateId", "toAgentId", "amount"]);
					const predicateId = identifier(item.predicateId),
						amount = finite(item.amount);
					if (
						amount <= 0 ||
						!pack.predicates.some(
							(p) => p.id === predicateId && p.policy.resource,
						)
					)
						throw Error("Invalid social transfer");
					return {
						kind,
						predicateId,
						amount,
						toAgentId: recipient(item.toAgentId),
					};
				}
				case "reveal":
					fields(item, ["kind", "claim", "toAgentId"]);
					return {
						kind,
						claim: parseClaimRef(item.claim),
						toAgentId: recipient(item.toAgentId),
					};
				case "goal":
					fields(item, ["kind", "goalId", "description"]);
					return {
						kind,
						goalId: identifier(item.goalId),
						description: authoringText(item.description),
					};
				default:
					throw Error("Invalid social primitive");
			}
		},
	);
	if (!primitives.length || primitives.length > 64)
		throw Error("Social primitive capacity exceeded");
	const seen = new Set<string>();
	for (const primitive of primitives) {
		const key =
			primitive.kind === "transfer"
				? `${primitive.kind}:${primitive.predicateId}:${primitive.toAgentId}`
				: primitive.kind === "reveal"
					? `${primitive.kind}:${primitive.claim.kind}:${primitive.claim.id}:${primitive.toAgentId}`
					: primitive.kind === "goal"
						? `${primitive.kind}:${primitive.goalId}`
						: primitive.kind;
		if (primitive.kind !== "extension" && seen.has(key))
			throw Error("Duplicate social primitive");
		seen.add(key);
	}
	const intent = {
		id: identifier(value.id),
		agentId,
		targetAgentId,
		capabilityId,
		description: authoringText(value.description),
		primitives,
	};
	return primitives.some((p) => p.kind === "extension")
		? { kind: "extension", intent }
		: {
				kind: "intent",
				intent: { ...intent, primitives: primitives as SocialPrimitive[] },
			};
}
