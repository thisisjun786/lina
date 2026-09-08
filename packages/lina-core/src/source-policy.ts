import { createHash } from "node:crypto";
import type { RequestStatus } from "./protocol.ts";

export type SourceScope = "ordinary" | "life" | "mixed" | "unclassified_legacy";
export type SourceMaterialKind =
	| "shared-growth"
	| "disclosed-life"
	| "author-world";
export interface SourcePolicy {
	version: 1;
	scope: SourceScope;
	sessionId: string;
	requestId: string;
	nativeEpoch: number;
	scopeDigest: string;
	policyRevision: number;
	contextReceiptIds: string[];
	materialKinds: SourceMaterialKind[];
}
export interface SourceProof {
	entryId: string;
	policyRevision: number;
	policyDigest: string;
}
/** Returned by the journal owner; source fields in content/raw are never used. */
export interface SourceEntry {
	entryId: string;
	role?: "user" | "assistant" | "tool" | "meta" | undefined;
	text: string;
	timestamp?: string | undefined;
	sourcePolicy?: SourcePolicy | undefined;
	requestStatus?: RequestStatus | undefined;
}
export type SourceLookup = (entryId: string) => SourceEntry | undefined;
/** Only the runtime's current working-context path may use this exception. */
export interface SourceContextOptions {
	activeRequestId?: string;
}

const KINDS: readonly SourceMaterialKind[] = [
	"shared-growth",
	"disclosed-life",
	"author-world",
];
const SCOPES: readonly SourceScope[] = [
	"ordinary",
	"life",
	"mixed",
	"unclassified_legacy",
];
const FIELDS = [
	"version",
	"scope",
	"sessionId",
	"requestId",
	"nativeEpoch",
	"scopeDigest",
	"policyRevision",
	"contextReceiptIds",
	"materialKinds",
];
// A storage/decoder bound, never a simulation cadence or spending default.
const MAX_REFS = 65_536;
function invalid(): never {
	throw Error("Invalid source provenance");
}
function object(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const result = value as Record<string, unknown>;
	if (
		Object.keys(result).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(result, key))
	)
		invalid();
	return result;
}
function identifier(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 256 ||
		value.trim() !== value ||
		[...value].some(
			(char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
		)
	)
		invalid();
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		invalid();
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}
function identifiers(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_REFS) invalid();
	const result = value.map(identifier);
	if (new Set(result).size !== result.length) invalid();
	return result.sort();
}

export function parseSourcePolicy(value: unknown): SourcePolicy {
	const input = object(value, FIELDS);
	const scope = input["scope"];
	if (input["version"] !== 1 || !SCOPES.includes(scope as SourceScope))
		invalid();
	const materialKinds = identifiers(input["materialKinds"]);
	if (materialKinds.some((kind) => !KINDS.includes(kind as SourceMaterialKind)))
		invalid();
	if (
		scope === "ordinary" &&
		materialKinds.some((kind) => kind !== "shared-growth")
	)
		invalid();
	return {
		version: 1,
		scope: scope as SourceScope,
		sessionId: identifier(input["sessionId"]),
		requestId: identifier(input["requestId"]),
		nativeEpoch: revision(input["nativeEpoch"]),
		scopeDigest: digest(input["scopeDigest"]),
		policyRevision: revision(input["policyRevision"]),
		contextReceiptIds: identifiers(input["contextReceiptIds"]),
		materialKinds: materialKinds as SourceMaterialKind[],
	};
}

export function sourcePolicyDigest(policy: SourcePolicy): string {
	return createHash("sha256")
		.update(JSON.stringify(parseSourcePolicy(policy)))
		.digest("hex");
}

export function parseSourceProof(value: unknown): SourceProof {
	const input = object(value, ["entryId", "policyRevision", "policyDigest"]);
	return {
		entryId: identifier(input["entryId"]),
		policyRevision: revision(input["policyRevision"]),
		policyDigest: digest(input["policyDigest"]),
	};
}

export function isOrdinarySource(
	entry: SourceEntry | undefined,
	options: SourceContextOptions = {},
): boolean {
	try {
		if (!entry?.sourcePolicy) return false;
		identifier(entry.entryId);
		const policy = parseSourcePolicy(entry.sourcePolicy);
		return (
			policy.scope === "ordinary" &&
			(entry.requestStatus === "settled" ||
				(entry.requestStatus === "accepted" &&
					options.activeRequestId === policy.requestId))
		);
	} catch {
		return false;
	}
}

export function captureSourceProofs(
	ids: readonly string[],
	lookup: SourceLookup,
	options: SourceContextOptions = {},
): SourceProof[] {
	const selected = identifiers(ids);
	if (selected.length === 0) invalid();
	return selected.map((id) => {
		const entry = lookup(id);
		if (
			!entry ||
			entry.entryId !== id ||
			!isOrdinarySource(entry, options) ||
			!entry.sourcePolicy
		)
			invalid();
		return {
			entryId: id,
			policyRevision: entry.sourcePolicy.policyRevision,
			policyDigest: sourcePolicyDigest(entry.sourcePolicy),
		};
	});
}

export function sourceProofsCurrent(
	proofs: readonly SourceProof[],
	lookup: SourceLookup,
	options: SourceContextOptions = {},
): boolean {
	try {
		if (!Array.isArray(proofs) || !proofs.length || proofs.length > MAX_REFS)
			return false;
		const parsed = proofs.map(parseSourceProof);
		const current = captureSourceProofs(
			parsed.map((proof) => proof.entryId),
			lookup,
			options,
		);
		const saved = new Map(parsed.map((proof) => [proof.entryId, proof]));
		return current.every((proof) => {
			const prior = saved.get(proof.entryId);
			return (
				prior?.policyRevision === proof.policyRevision &&
				prior.policyDigest === proof.policyDigest
			);
		});
	} catch {
		return false;
	}
}
