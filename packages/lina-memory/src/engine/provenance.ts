import {
	type SourceLookup,
	type SourceProof,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import type { EngineRecord } from "./types.ts";
import { parseProofs, validateSources } from "./validation.ts";

export function requireCurrentProofs(
	proofs: SourceProof[] | undefined,
	lookup: SourceLookup,
): asserts proofs is SourceProof[] {
	if (!proofs || !sourceProofsCurrent(proofs, lookup))
		throw Error("ineligible or stale engine source provenance");
}
export function eligibleRecord(
	record: EngineRecord,
	lookup: SourceLookup,
): boolean {
	if (
		!record.sourceRequestId ||
		!record.sourceProofs ||
		!sourceProofsCurrent(record.sourceProofs, lookup)
	)
		return false;
	try {
		validateSources([record], lookup);
		return true;
	} catch {
		return false;
	}
}
export function mergeProofs(
	...groups: (SourceProof[] | undefined)[]
): SourceProof[] {
	const proofs = new Map<string, SourceProof>();
	for (const group of groups)
		for (const proof of group ?? []) {
			const previous = proofs.get(proof.entryId);
			if (
				previous &&
				(previous.policyRevision !== proof.policyRevision ||
					previous.policyDigest !== proof.policyDigest)
			)
				throw Error("conflicting engine source proofs");
			proofs.set(proof.entryId, proof);
		}
	return parseProofs([...proofs.values()]);
}
