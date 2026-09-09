import { createHash } from "node:crypto";
import { TaskError } from "./task-types.ts";
import type {
	ConfirmWorkInput,
	CorrectWorkInput,
	ShareWorkInput,
	WorkDeliveryPayload,
	WorkNativeStatus,
	WorkProof,
	WorkReceipt,
	WorkSharingDecision,
	WorkSharingSelection,
} from "./task-work-types.ts";

export function workObject(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TaskError("invalid_input", "invalid work object");
	const r = value as Record<string, unknown>;
	if (
		Object.keys(r).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(r, k))
	)
		throw new TaskError("invalid_input", "unknown or missing work fields");
	return r;
}
export function workText(value: unknown, max = 2048): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) < 32 &&
				![9, 10, 13].includes(character.charCodeAt(0)),
		)
	)
		throw new TaskError("invalid_input", "invalid work text");
	return value;
}
export function workId(value: unknown): string {
	const s = workText(value, 128);
	if (!/^[A-Za-z0-9_.:-]+$/.test(s))
		throw new TaskError("invalid_input", "invalid work id");
	return s;
}
export function workRevision(value: unknown, min = 1): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		throw new TaskError("invalid_input", "invalid work revision");
	return value;
}
function ids(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 256)
		throw new TaskError("invalid_input", "invalid work ids");
	const result = value.map(workId);
	if (new Set(result).size !== result.length)
		throw new TaskError("invalid_input", "duplicate work ids");
	return result;
}
export function nativeWorkStatus(value: unknown): WorkNativeStatus | null {
	return value === "completed" || value === "failed" || value === "interrupted"
		? value
		: null;
}
export function parseConfirmWorkInput(value: unknown): ConfirmWorkInput {
	const r = workObject(value, [
		"receiptId",
		"expectedReceiptRevision",
		"requestId",
		"evidenceRef",
	]);
	return {
		receiptId: workId(r["receiptId"]),
		expectedReceiptRevision: workRevision(r["expectedReceiptRevision"]),
		requestId: workId(r["requestId"]),
		evidenceRef: workText(r["evidenceRef"]),
	};
}
export function parseCorrectWorkInput(value: unknown): CorrectWorkInput {
	const r = workObject(value, [
		"receiptId",
		"expectedReceiptRevision",
		"requestId",
		"kind",
		"reason",
	]);
	if (r["kind"] !== "amend" && r["kind"] !== "retract")
		throw new TaskError("invalid_input", "invalid work correction");
	return {
		receiptId: workId(r["receiptId"]),
		expectedReceiptRevision: workRevision(r["expectedReceiptRevision"]),
		requestId: workId(r["requestId"]),
		kind: r["kind"],
		reason: workText(r["reason"]),
	};
}
export function parseWorkSelection(
	value: unknown,
): WorkSharingSelection | null {
	if (value === null) return null;
	const r = workObject(value, [
		"worldIds",
		"categoryId",
		"shareOutcome",
		"shareParticipants",
		"summary",
	]);
	const worldIds = ids(r["worldIds"]).sort();
	if (
		!worldIds.length ||
		typeof r["shareOutcome"] !== "boolean" ||
		typeof r["shareParticipants"] !== "boolean"
	)
		throw new TaskError(
			"invalid_input",
			"explicit work targets and fields required",
		);
	return {
		worldIds,
		categoryId: workId(r["categoryId"]),
		shareOutcome: r["shareOutcome"],
		shareParticipants: r["shareParticipants"],
		summary: r["summary"] === null ? null : workText(r["summary"]),
	};
}
export function parseShareWorkInput(value: unknown): ShareWorkInput {
	const r = workObject(value, [
		"receiptId",
		"expectedPolicyRevision",
		"requestId",
		"selection",
	]);
	return {
		receiptId: workId(r["receiptId"]),
		expectedPolicyRevision: workRevision(r["expectedPolicyRevision"], 0),
		requestId: workId(r["requestId"]),
		selection: parseWorkSelection(r["selection"]),
	};
}
export function parseWorkReceipt(value: unknown): WorkReceipt {
	const r = workObject(value, [
		"version",
		"id",
		"taskId",
		"turnId",
		"taskRevision",
		"receiptRevision",
		"ownerAgentId",
		"participantAgentIds",
		"attributionStatus",
		"outcome",
		"supersedesRevision",
		"correction",
		"evidenceRefs",
	]);
	if (
		r["version"] !== 1 ||
		!["turn_ended", "verified_result", "failed", "interrupted"].includes(
			String(r["outcome"]),
		)
	)
		throw new TaskError(
			"invalid_input",
			"unknown work receipt version or outcome",
		);
	const receiptRevision = workRevision(r["receiptRevision"]);
	const ownerAgentId =
		r["ownerAgentId"] === null ? null : workId(r["ownerAgentId"]);
	const participantAgentIds = ids(r["participantAgentIds"]);
	if (
		r["attributionStatus"] !== "known" &&
		r["attributionStatus"] !== "unknown"
	)
		throw new TaskError("invalid_input", "invalid attribution");
	if (
		r["attributionStatus"] === "unknown"
			? ownerAgentId !== null || participantAgentIds.length > 0
			: ownerAgentId === null || !participantAgentIds.includes(ownerAgentId)
	)
		throw new TaskError("invalid_input", "inconsistent work attribution");
	const supersedesRevision =
		r["supersedesRevision"] === null
			? null
			: workRevision(r["supersedesRevision"]);
	if (
		supersedesRevision !== (receiptRevision === 1 ? null : receiptRevision - 1)
	)
		throw new TaskError("invalid_input", "broken receipt revision chain");
	let correction: WorkReceipt["correction"] = null;
	if (r["correction"] !== null) {
		const c = workObject(r["correction"], ["kind", "reason"]);
		if (c["kind"] !== "amend" && c["kind"] !== "retract")
			throw new TaskError("invalid_input", "invalid correction");
		correction = { kind: c["kind"], reason: workText(c["reason"]) };
	}
	if (!Array.isArray(r["evidenceRefs"]) || r["evidenceRefs"].length > 1)
		throw new TaskError("invalid_input", "invalid work evidence");
	const evidenceRefs = r["evidenceRefs"].map(
		(v): WorkReceipt["evidenceRefs"][number] => {
			const e = workObject(v, [
				"kind",
				"authorityId",
				"reference",
				"receiptRevision",
			]);
			if (e["kind"] !== "owner_confirmation" && e["kind"] !== "verifier")
				throw new TaskError("invalid_input", "invalid evidence kind");
			return {
				kind: e["kind"],
				authorityId: workId(e["authorityId"]),
				reference: workText(e["reference"]),
				receiptRevision: workRevision(e["receiptRevision"]),
			};
		},
	);
	if (
		(r["outcome"] === "verified_result") !== (evidenceRefs.length === 1) ||
		(evidenceRefs[0] &&
			evidenceRefs[0].receiptRevision !== receiptRevision - 1) ||
		(correction !== null && (receiptRevision === 1 || evidenceRefs.length > 0))
	)
		throw new TaskError("invalid_input", "inconsistent work evidence revision");
	return {
		version: 1,
		id: workId(r["id"]),
		taskId: workId(r["taskId"]),
		turnId: workId(r["turnId"]),
		taskRevision: workRevision(r["taskRevision"], 0),
		receiptRevision,
		ownerAgentId,
		participantAgentIds,
		attributionStatus: r["attributionStatus"],
		outcome: r["outcome"] as WorkReceipt["outcome"],
		supersedesRevision,
		correction,
		evidenceRefs,
	};
}
export function parseWorkSharingDecision(value: unknown): WorkSharingDecision {
	const r = workObject(value, [
		"version",
		"taskId",
		"receiptId",
		"policyRevision",
		"selection",
	]);
	if (r["version"] !== 1)
		throw new TaskError("invalid_input", "unknown sharing version");
	const decision = {
		version: 1 as const,
		taskId: workId(r["taskId"]),
		receiptId: workId(r["receiptId"]),
		policyRevision: workRevision(r["policyRevision"], 0),
		selection: parseWorkSelection(r["selection"]),
	};
	if (decision.policyRevision === 0 && decision.selection !== null)
		throw new TaskError("invalid_input", "unset policy has no selection");
	return decision;
}
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}
export function workDigest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}
export function workDeliveryId(
	receiptId: string,
	receiptRevision: number,
	policyRevision: number,
	worldId: string,
	operation: "upsert" | "restrict",
): string {
	return workDigest([
		receiptId,
		receiptRevision,
		policyRevision,
		worldId,
		operation,
	]);
}
export function workExperienceKey(
	receiptId: string,
	receiptRevision: number,
	worldId: string,
	agentId: string,
): string {
	return workDigest([
		workId(receiptId),
		workRevision(receiptRevision),
		workId(worldId),
		workId(agentId),
	]);
}
export function workProof(
	delivery: WorkDeliveryPayload & { payloadDigest: string },
): WorkProof {
	return {
		taskId: delivery.receipt.taskId,
		receiptId: delivery.receipt.id,
		receiptRevision: delivery.receipt.receiptRevision,
		policyRevision: delivery.policyRevision,
		worldId: delivery.worldId,
		payloadDigest: delivery.payloadDigest,
	};
}
