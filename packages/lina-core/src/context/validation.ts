import { createHash } from "node:crypto";
import {
	parseSourceProof,
	type SourceLookup,
	type SourceProof,
	sourceProofsCurrent,
} from "../source-policy.ts";
import { parseSummaryGeneration } from "./generation.ts";
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

export function fingerprintOf(
	input: StageInput,
	proofs: SourceProof[] = [],
): string {
	const hash = createHash("sha256");
	hash.update(
		JSON.stringify([
			input.kind,
			input.text,
			input.sources.map((ref) => [ref.kind, ref.id]),
			proofs,
		]),
	);
	if (input.generation)
		hash.update(JSON.stringify(parseSummaryGeneration(input.generation)));
	return hash.digest("hex");
}

export function decodeProofs(value: unknown): SourceProof[] {
	if (!Array.isArray(value)) throw Error("Invalid context source proofs");
	const proofs = value.map(parseSourceProof);
	if (
		proofs.length > 65536 ||
		new Set(proofs.map((p) => p.entryId)).size !== proofs.length
	)
		throw Error("Invalid context source proofs");
	return proofs;
}

export function unionProofs(...groups: SourceProof[][]): SourceProof[] {
	const proofs = new Map<string, SourceProof>();
	for (const proof of groups.flat()) {
		const previous = proofs.get(proof.entryId);
		if (
			previous &&
			(previous.policyRevision !== proof.policyRevision ||
				previous.policyDigest !== proof.policyDigest)
		)
			throw Error("Conflicting context source proofs");
		proofs.set(proof.entryId, proof);
	}
	return [...proofs.values()].sort((a, b) =>
		a.entryId.localeCompare(b.entryId),
	);
}

/** Runtime delivery guard: retain the original snapshot, never recapture after await. */
export function sourceDeliveryGuard(
	proofs: SourceProof[],
	lookup: SourceLookup,
): () => void {
	const original = decodeProofs(proofs);
	return () => {
		if (original.length && !sourceProofsCurrent(original, lookup))
			throw Error("Context source provenance changed before delivery");
	};
}
