import {
	parseSourceProof,
	type SourceLookup,
	type SourceProof,
	sourceProofsCurrent,
} from "../source-policy.ts";
export interface LearnedProvenance {
	sourceProofs: SourceProof[];
	lookup: SourceLookup;
}
export function parseLearnedProofs(value: unknown): SourceProof[] {
	if (!Array.isArray(value) || !value.length || value.length > 65536)
		throw Error("invalid learned source proofs");
	const proofs = value.map(parseSourceProof);
	if (new Set(proofs.map((p) => p.entryId)).size !== proofs.length)
		throw Error("duplicate learned source proof");
	return proofs.sort((a, b) => a.entryId.localeCompare(b.entryId));
}
export function unionLearnedProofs(...groups: SourceProof[][]): SourceProof[] {
	const values = new Map<string, SourceProof>();
	for (const group of groups)
		for (const proof of group) {
			const previous = values.get(proof.entryId);
			if (
				previous &&
				(previous.policyDigest !== proof.policyDigest ||
					previous.policyRevision !== proof.policyRevision)
			)
				throw Error("conflicting learned source proofs");
			values.set(proof.entryId, proof);
		}
	return values.size ? parseLearnedProofs([...values.values()]) : [];
}
export function assertLearnedProvenance(
	provenance: LearnedProvenance,
	requestId: string,
	userIds: string[],
	text?: string,
): SourceProof[] {
	const proofs = parseLearnedProofs(provenance.sourceProofs);
	if (!sourceProofsCurrent(proofs, provenance.lookup) || !userIds.length)
		throw Error("ineligible or stale learned source provenance");
	for (const id of userIds) {
		const entry = provenance.lookup(id);
		if (
			!proofs.some((p) => p.entryId === id) ||
			entry?.role !== "user" ||
			entry.sourcePolicy?.requestId !== requestId ||
			(text !== undefined && entry.text !== text)
		)
			throw Error("invalid learned source request binding");
	}
	return proofs;
}
