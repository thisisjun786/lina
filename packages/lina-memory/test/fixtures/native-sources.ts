import type {
	SourceEntry,
	SourcePolicy,
} from "../../../lina-core/src/source-policy.ts";

export function ordinarySource(entry: SourceEntry): SourceEntry {
	return {
		...entry,
		requestStatus: "settled",
		sourcePolicy: {
			version: 1,
			scope: "ordinary",
			sessionId: "fixture-session",
			requestId: `request-${entry.entryId}`,
			nativeEpoch: 1,
			scopeDigest: "a".repeat(64),
			policyRevision: 1,
			contextReceiptIds: [],
			materialKinds: [],
		},
	};
}
export function restrictSource(entry: SourceEntry): void {
	const policy = entry.sourcePolicy;
	if (!policy) throw Error("missing fixture policy");
	entry.sourcePolicy = {
		...policy,
		scope: "mixed",
		policyRevision: policy.policyRevision + 1,
		materialKinds: ["disclosed-life"],
	} satisfies SourcePolicy;
}
