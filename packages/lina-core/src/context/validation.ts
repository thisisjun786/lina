import { createHash } from "node:crypto";
import {
	CONTEXT_ID_MAX_CHARS,
	type SourceRef,
	type StageInput,
} from "./types.ts";

export function validId(value: unknown, what: string): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > CONTEXT_ID_MAX_CHARS ||
		value.includes("\0")
	)
		throw new Error(`invalid ${what}`);
	return value;
}

export function validRef(value: unknown): SourceRef {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("invalid source ref");
	const ref = value as Record<string, unknown>;
	if (Object.keys(ref).length !== 2)
		throw new Error("invalid source ref fields");
	if (ref["kind"] !== "entry" && ref["kind"] !== "summary")
		throw new Error("invalid source ref kind");
	return { kind: ref["kind"], id: validId(ref["id"], "source ref id") };
}

export function fingerprintOf(input: StageInput): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify([
			input.kind,
			input.text,
			input.sources.map((ref) => [ref.kind, ref.id]),
		]),
	);
	return hash.digest("hex");
}
