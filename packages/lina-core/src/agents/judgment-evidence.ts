import type {
	Assessment,
	IntentionRecord,
	JudgmentSnapshotRef,
} from "./judgment.ts";
import type { CandidateSet } from "./judgment-candidates.ts";
import {
	INTENTION_TRANSITIONS,
	intentionDigest,
	parseIntentionRecord,
	snapshotDigest,
} from "./judgment-validation.ts";

/** Owner lookup is trusted Host code, never a model-provided evidence claim.
 * The same frozen evidence rules apply to closure, arbitration and store replay.
 */
export function validateCandidateEvidence(
	set: CandidateSet,
	snapshot: JudgmentSnapshotRef,
	lookup: (id: string) => IntentionRecord | null,
	assessments: Assessment[],
	current: boolean,
): void {
	if (
		set.roundId !== snapshot.roundId ||
		set.snapshotDigest !== snapshotDigest(snapshot)
	)
		throw Error("candidate snapshot mismatch");
	const referenced = new Map<string, IntentionRecord>();
	for (const ref of set.intentionRefs) {
		const record = lookup(ref.intentionId);
		if (
			!record ||
			record.agentId !== snapshot.agentId ||
			record.scopeId !== snapshot.scopeId
		)
			throw Error("candidate intention scope or reference mismatch");
		if (
			record.revision < ref.revision ||
			(current && record.revision !== ref.revision)
		)
			throw Error("stale candidate intention revision");
		// This owner changes only status/revision/history. Preserve every original
		// field while reconstructing the frozen revision from validated history.
		const historical = parseIntentionRecord({
			...record,
			revision: ref.revision,
			status: ref.status,
			history: record.history.slice(0, ref.revision),
		});
		if (intentionDigest(historical) !== ref.digest)
			throw Error("candidate intention digest mismatch");
		referenced.set(ref.intentionId, historical);
	}
	const eligible = new Set(
		set.eligibility.filter((r) => r.eligible).map((r) => r.optionKey),
	);
	for (const option of set.options) {
		if (
			option.actor.agentId !== snapshot.agentId ||
			option.actor.scopeId !== snapshot.scopeId
		)
			throw Error("candidate actor snapshot mismatch");
		const precondition = option.preconditions;
		if (!eligible.has(option.optionKey) || !("intentionId" in precondition))
			continue;
		const record = referenced.get(precondition.intentionId);
		if (!record) throw Error("missing candidate intention ref");
		if (
			"acceptanceSourceRef" in precondition &&
			precondition.acceptanceSourceRef !== record.acceptance.sourceRef
		)
			throw Error("candidate original acceptance mismatch");
		if (precondition.kind === "task.start") continue;
		if (option.targetId !== record.intentionId)
			throw Error("candidate intention target mismatch");
		const to = (
			{
				"intention.activate": "active",
				"intention.resume": "active",
				"intention.suspend": "suspended",
				"intention.cancel": "cancelled",
				"intention.complete": "completed",
			} as const
		)[precondition.kind];
		if (
			!INTENTION_TRANSITIONS[record.status].includes(to) ||
			(precondition.kind === "intention.activate" &&
				record.status !== "adopted") ||
			(precondition.kind === "intention.resume" &&
				record.status !== "suspended")
		)
			throw Error("illegal candidate intention transition");
	}
	const keys = new Set(set.options.map((o) => o.optionKey));
	for (const assessment of assessments) {
		if (
			[
				...assessment.proposedOptionKeys,
				...assessment.recommendedOptionKeys,
				...assessment.objectiveAssessments.map((o) => o.optionKey),
			].some((key) => !keys.has(key))
		)
			throw Error("unknown assessment option key");
		if (assessment.moduleKind !== "atropos") continue;
		for (const opinion of assessment.objectiveAssessments) {
			for (const id of opinion.breachedIntentionIds ?? []) {
				const record = referenced.get(id);
				if (
					record?.kind !== "user_commitment" ||
					record.acceptance.acceptedBy !== "user" ||
					!["adopted", "active", "suspended"].includes(record.status)
				)
					throw Error("missing protected commitment evidence");
			}
		}
	}
}
