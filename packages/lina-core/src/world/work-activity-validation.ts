import {
	digest,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { fields, text } from "./validation.ts";
import type {
	ResourceActivityReceipt,
	ResourceActivitySource,
} from "./work-types.ts";

const OUTCOMES = ["recorded", "verified_result", "failed"] as const;
export function parseResourceActivityReceipt(
	value: unknown,
): ResourceActivityReceipt {
	fields(value, [
		"activityId",
		"activityRevision",
		"supersedesRevision",
		"resourceId",
		"resourceRevision",
		"versionId",
		"memoryId",
		"actorAgentId",
		"participantAgentIds",
		"activityKind",
		"outcome",
		"evidenceDigest",
		"grantId",
		"grantRevision",
		"correction",
	]);
	const activityRevision = revision(value.activityRevision, 1);
	const supersedesRevision =
		value.supersedesRevision === null
			? null
			: revision(value.supersedesRevision, 1);
	if (
		supersedesRevision !==
		(activityRevision === 1 ? null : activityRevision - 1)
	)
		throw Error("Invalid resource activity correction chain");
	const actorAgentId = identifier(value.actorAgentId),
		participantAgentIds = identifiers(value.participantAgentIds);
	if (!participantAgentIds.includes(actorAgentId))
		throw Error("Invalid resource activity attribution");
	let correction: ResourceActivityReceipt["correction"] = null;
	if (value.correction !== null) {
		fields(value.correction, ["kind", "reason"]);
		text(value.correction.reason, "resource activity correction reason");
		if (activityRevision === 1)
			throw Error("Initial resource activity cannot be corrected");
		correction = {
			kind: enumeration(value.correction.kind, ["amend", "retract"]),
			reason: value.correction.reason,
		};
	}
	const outcome = enumeration(value.outcome, OUTCOMES),
		evidenceDigest = digest(value.evidenceDigest);
	if (outcome === "verified_result" && evidenceDigest === lifeDigest([]))
		throw Error("Missing resource result evidence");
	return {
		activityId: identifier(value.activityId),
		activityRevision,
		supersedesRevision,
		resourceId: identifier(value.resourceId),
		resourceRevision: revision(value.resourceRevision, 1),
		versionId: identifier(value.versionId),
		memoryId: nullableId(value.memoryId),
		actorAgentId,
		participantAgentIds,
		activityKind: enumeration(value.activityKind, [
			"development",
			"research",
			"writing",
			"organization",
			"search",
			"other",
		]),
		outcome,
		evidenceDigest,
		grantId: identifier(value.grantId),
		grantRevision: revision(value.grantRevision, 1),
		correction,
	};
}
/** Structural admission only; the resource owner separately verifies actual source bytes and grants. */
export function parseResourceActivitySource(
	value: unknown,
): ResourceActivitySource {
	jsonBoundary(value);
	fields(value, [
		"kind",
		"version",
		"deliveryId",
		"operation",
		"sourceDigest",
		"policyRevision",
		"receipt",
		"fields",
	]);
	if (value.kind !== "resource_activity" || value.version !== 1)
		throw Error("Invalid resource activity source version");
	const operation = enumeration(value.operation, ["upsert", "restrict"]),
		receipt = parseResourceActivityReceipt(value.receipt);
	let shared: ResourceActivitySource["fields"] = null;
	if (value.fields !== null) {
		fields(value.fields, [
			"categoryId",
			"outcome",
			"participantAgentIds",
			"summary",
		]);
		const outcome =
			value.fields.outcome === null
				? null
				: enumeration(value.fields.outcome, OUTCOMES);
		const participantAgentIds =
			value.fields.participantAgentIds === null
				? null
				: identifiers(value.fields.participantAgentIds);
		if (
			(outcome !== null && outcome !== receipt.outcome) ||
			participantAgentIds?.some(
				(id) => !receipt.participantAgentIds.includes(id),
			)
		)
			throw Error("Invalid shared resource activity projection");
		if (value.fields.summary !== null)
			text(value.fields.summary, "shared resource activity summary");
		shared = {
			categoryId: identifier(value.fields.categoryId),
			outcome,
			participantAgentIds,
			summary: value.fields.summary,
		};
	}
	if (
		operation === "restrict"
			? shared !== null
			: shared === null || receipt.correction?.kind === "retract"
	)
		throw Error("Invalid resource activity restriction");
	return {
		kind: "resource_activity",
		version: 1,
		deliveryId: identifier(value.deliveryId),
		operation,
		sourceDigest: digest(value.sourceDigest),
		policyRevision: revision(value.policyRevision, 1),
		receipt,
		fields: shared,
	};
}
