import type { WorldPack } from "./authoring-types.ts";
import {
	array,
	digest,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { fields, text } from "./validation.ts";
import type {
	SharedWorkFields,
	WorkConfig,
	WorkEvidenceSnapshot,
	WorkInfluenceRule,
	WorkInputSource,
	WorkReceiptProvenance,
} from "./work-types.ts";

const OUTCOMES = [
	"turn_ended",
	"verified_result",
	"failed",
	"interrupted",
] as const;

export function parseWorkReceiptProvenance(
	value: unknown,
): WorkReceiptProvenance {
	fields(value, [
		"receiptId",
		"receiptRevision",
		"supersedesRevision",
		"taskId",
		"turnId",
		"taskRevision",
		"ownerAgentId",
		"participantAgentIds",
		"attributionStatus",
		"outcome",
		"correction",
		"evidenceDigest",
	]);
	const receiptRevision = revision(value.receiptRevision, 1);
	const supersedesRevision =
		value.supersedesRevision === null
			? null
			: revision(value.supersedesRevision, 1);
	if (
		supersedesRevision !== (receiptRevision === 1 ? null : receiptRevision - 1)
	)
		throw Error("Invalid work correction chain");
	const ownerAgentId = nullableId(value.ownerAgentId),
		participantAgentIds = identifiers(value.participantAgentIds),
		attributionStatus = enumeration(value.attributionStatus, [
			"known",
			"unknown",
		]);
	if (
		attributionStatus === "unknown"
			? ownerAgentId !== null || participantAgentIds.length > 0
			: ownerAgentId === null || !participantAgentIds.includes(ownerAgentId)
	)
		throw Error("Invalid work attribution");
	let correction: WorkReceiptProvenance["correction"] = null;
	if (value.correction !== null) {
		fields(value.correction, ["kind", "reason"]);
		text(value.correction.reason, "work correction reason");
		correction = {
			kind: enumeration(value.correction.kind, ["amend", "retract"]),
			reason: value.correction.reason,
		};
		if (receiptRevision === 1)
			throw Error("Initial work receipt cannot be corrected");
	}
	const outcome = enumeration(value.outcome, OUTCOMES),
		evidenceDigest = digest(value.evidenceDigest);
	if (outcome === "verified_result" && evidenceDigest === lifeDigest([]))
		throw Error("Missing work verification evidence");
	return {
		receiptId: identifier(value.receiptId),
		receiptRevision,
		supersedesRevision,
		taskId: identifier(value.taskId),
		turnId: identifier(value.turnId),
		taskRevision: revision(value.taskRevision, 1),
		ownerAgentId,
		participantAgentIds,
		attributionStatus,
		outcome,
		correction,
		evidenceDigest,
	};
}
export function parseWorkInputSource(value: unknown): WorkInputSource {
	jsonBoundary(value);
	fields(value, [
		"kind",
		"deliveryId",
		"operation",
		"sourceDigest",
		"policyRevision",
		"receipt",
		"fields",
	]);
	const kind = enumeration(value.kind, ["work"]),
		operation = enumeration(value.operation, ["upsert", "restrict"]),
		receipt = parseWorkReceiptProvenance(value.receipt);
	let shared: SharedWorkFields | null = null;
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
			throw Error("Invalid shared work projection");
		if (value.fields.summary !== null)
			text(value.fields.summary, "shared work summary");
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
		throw Error("Invalid work restriction");
	return {
		kind,
		deliveryId: identifier(value.deliveryId),
		operation,
		sourceDigest: digest(value.sourceDigest),
		policyRevision: revision(value.policyRevision, 1),
		receipt,
		fields: shared,
	};
}

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

export function parseWorkEvidence(value: unknown): WorkEvidenceSnapshot {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"revision",
		"permissionRevision",
		"workConfigDigest",
		"records",
	]);
	if (value.version !== 1) throw Error("Invalid work evidence version");
	const records = keyed(
		array(value.records, (raw) => {
			fields(raw, ["inputId", "source"]);
			const source = parseWorkInputSource(raw.source);
			const inputId = identifier(raw.inputId);
			if (inputId !== source.deliveryId)
				throw Error("Invalid work input binding");
			return { inputId, source };
		}),
		(r) => r.source.receipt.receiptId,
	);
	const current = revision(value.revision),
		permission = revision(value.permissionRevision);
	if (permission > current) throw Error("Invalid work evidence revision");
	return {
		version: 1,
		worldId: identifier(value.worldId),
		revision: current,
		permissionRevision: permission,
		workConfigDigest: digest(value.workConfigDigest),
		records,
	};
}
