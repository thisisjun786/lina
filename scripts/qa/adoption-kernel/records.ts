// biome-ignore-all lint/complexity/useLiteralKeys: strict indexed access for persisted unknown records.
import {
	parseJudgment,
	parseQuality,
	parseReceipt,
	parseRef,
} from "./validation.ts";

/** Validate persisted domain rows before trusted generic consumers see them. */
export function decodeRecord(
	kind: string,
	id: unknown,
	revision: unknown,
	text: unknown,
): unknown {
	if (typeof text !== "string") throw Error("invalid stored JSON");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid stored record");
	const r = value as Record<string, unknown>;
	if (
		r["id"] !== id ||
		r["revision"] !== revision ||
		!Number.isSafeInteger(revision) ||
		Number(revision) < 0
	)
		throw Error("stored identity mismatch");
	const strings = (...keys: string[]) => {
		for (const k of keys)
			if (typeof r[k] !== "string" || !r[k]) throw Error(`invalid stored ${k}`);
	};
	const choice = (key: string, values: string[]) => {
		if (!values.includes(String(r[key]))) throw Error(`invalid stored ${key}`);
	};
	const refs = (key: string) => {
		if (!Array.isArray(r[key])) throw Error(`invalid stored ${key}`);
		for (const ref of r[key]) parseRef(ref);
	};
	strings("id", "subject", "text");
	let allowed: string[];
	if (kind === "purpose") {
		strings("successCriteria");
		choice("audience", ["private", "public"]);
		if (
			typeof r["active"] !== "boolean" ||
			!Number.isSafeInteger(r["policyVersion"]) ||
			Number(r["policyVersion"]) < 0
		)
			throw Error("invalid purpose policy");
		allowed = [
			"id",
			"revision",
			"subject",
			"text",
			"audience",
			"successCriteria",
			"active",
			"policyVersion",
		];
	} else if (kind === "evidence") {
		strings("sourceOwner", "sourceId");
		choice("domain", ["real", "fiction"]);
		choice("visibility", ["private", "public"]);
		choice("participantRole", ["performer", "observer", "recipient"]);
		if (typeof r["active"] !== "boolean")
			throw Error("invalid evidence active");
		refs("parents");
		parseQuality(r["quality"]);
		allowed = [
			"id",
			"revision",
			"subject",
			"domain",
			"visibility",
			"text",
			"active",
			"sourceOwner",
			"sourceId",
			"parents",
			"participantRole",
			"quality",
		];
	} else if (kind === "adoption") {
		strings("condition", "sourceDecisionId");
		choice("domain", ["real", "fiction"]);
		choice("visibility", ["private", "public"]);
		choice("kind", ["understanding", "plan", "intention"]);
		choice("status", ["active", "withdrawn"]);
		refs("refs");
		allowed = [
			"id",
			"revision",
			"subject",
			"domain",
			"visibility",
			"kind",
			"text",
			"refs",
			"condition",
			"status",
			"sourceDecisionId",
		];
	} else throw Error("unknown stored record kind");
	if (Object.keys(r).some((k) => !allowed.includes(k)))
		throw Error("unknown stored record field");
	return r;
}

/** Validate a persisted dependency snapshot before using its scope labels. */
export function decodeFrame(value: unknown): import("./types.ts").Frame {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid stored frame");
	const frame = value as Record<string, unknown>;
	if (
		frame["version"] !== 1 ||
		!Array.isArray(frame["evidence"]) ||
		!Array.isArray(frame["adoptions"]) ||
		!Array.isArray(frame["receipts"])
	)
		throw Error("invalid stored frame");
	const validate = (kind: string, value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw Error("invalid frame row");
		const row = value as Record<string, unknown>;
		decodeRecord(kind, row["id"], row["revision"], JSON.stringify(row));
	};
	validate("purpose", frame["purpose"]);
	for (const item of frame["evidence"]) validate("evidence", item);
	for (const item of frame["adoptions"]) validate("adoption", item);
	for (const item of frame["receipts"]) parseReceipt(item);
	return value as import("./types.ts").Frame;
}

export function decodeDecision(text: unknown): Record<string, unknown> {
	if (typeof text !== "string") throw Error("invalid stored decision");
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid stored decision");
	const data = value as Record<string, unknown>;
	const frame = decodeFrame(data["frame"]);
	if (
		data["purposeId"] !== frame.purpose.id ||
		data["policyVersion"] !== frame.purpose.policyVersion ||
		![
			"prepared",
			"adopted",
			"deferred",
			"resumed",
			"answered",
			"dispatched",
			"rejected",
			"noop",
			"unknown",
		].includes(String(data["status"]))
	)
		throw Error("invalid stored decision");
	parseJudgment({ method: data["method"], expectation: data["expectation"] });
	if (
		data["judgmentRecorded"] !== undefined &&
		typeof data["judgmentRecorded"] !== "boolean"
	)
		throw Error("invalid stored judgment");
	if (data["status"] === "deferred" || data["status"] === "resumed") {
		if (
			typeof data["condition"] !== "string" ||
			!data["condition"] ||
			typeof data["reason"] !== "string" ||
			typeof data["signaled"] !== "boolean"
		)
			throw Error("invalid stored defer");
	}
	if (
		data["status"] === "resumed" &&
		(data["signaled"] !== true ||
			typeof data["nextDecisionId"] !== "string" ||
			!data["nextDecisionId"])
	)
		throw Error("invalid stored wake");
	if (data["status"] === "adopted") {
		const adoption = data["adoption"] as Record<string, unknown> | undefined;
		if (!adoption) throw Error("invalid stored adoption decision");
		decodeRecord(
			"adoption",
			adoption["id"],
			adoption["revision"],
			JSON.stringify(adoption),
		);
	}
	return data;
}
