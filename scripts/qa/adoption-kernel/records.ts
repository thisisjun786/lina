// biome-ignore-all lint/complexity/useLiteralKeys: strict indexed access for persisted unknown records.
import { parseQuality, parseRef } from "./validation.ts";

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
