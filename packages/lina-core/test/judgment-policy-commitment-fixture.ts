import type { IntentionRecord } from "../src/agents/judgment.ts";
import { buildCandidateSet } from "../src/agents/judgment-candidates.ts";
import type { resolvePersonalRound } from "../src/agents/judgment-policy.ts";
import {
	intentionDigest,
	parseIntentionRecord,
	snapshotDigest,
	transitionIntention,
} from "../src/agents/judgment-validation.ts";

type PolicyInput = Parameters<typeof resolvePersonalRound>[0];
/** Valid owner records for policy-only tests; SQLite owner integration is covered
 * independently by judgment-policy-evidence-replay-review.test.ts.
 */
export function withCommitmentEvidence(
	input: PolicyInput,
	commitments: Array<{ id: string; sourceRef: string; suspended?: boolean }> = [
		{ id: "intention", sourceRef: "request" },
	],
): PolicyInput {
	const at = "2026-09-12T00:00:00.000Z";
	const records = commitments.map(({ id, sourceRef, suspended }) => {
		const proposed = parseIntentionRecord({
			schemaVersion: 1,
			intentionId: id,
			agentId: input.snapshot.agentId,
			scopeId: input.snapshot.scopeId,
			revision: 0,
			kind: "user_commitment",
			purposeRef: "purpose",
			text: "keep promise",
			acceptance: {
				sourceRef,
				acceptedBy: "user",
				policyRevision: 1,
				acceptedAt: at,
			},
			priority: 0,
			deadline: null,
			completionCondition: "receipt",
			abortConditions: [],
			relatedIntentions: [],
			status: "proposed",
			history: [],
		});
		const adopted = transitionIntention(proposed, {
			to: "adopted",
			reason: "accept",
			evidenceRef: sourceRef,
			at,
		});
		return suspended
			? transitionIntention(adopted, {
					to: "suspended",
					reason: "pause",
					evidenceRef: sourceRef,
					at,
				})
			: adopted;
	});
	const owner = new Map<string, IntentionRecord>(
		records.map((record) => [record.intentionId, record]),
	);
	return {
		...input,
		evidence: {
			candidates: buildCandidateSet({
				roundId: input.snapshot.roundId,
				snapshotDigest: snapshotDigest(input.snapshot),
				options: input.options,
				eligibility: input.eligibility,
				intentionRefs: records.map((record) => ({
					intentionId: record.intentionId,
					revision: record.revision,
					status: record.status,
					digest: intentionDigest(record),
				})),
			}),
			lookupIntention: (id) => owner.get(id) ?? null,
		},
	};
}
