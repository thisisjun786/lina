import { afterEach, expect, test } from "bun:test";
import type { ResolutionRecord } from "../src/agents/judgment.ts";
import { buildCandidateSet } from "../src/agents/judgment-candidates.ts";
import {
	PERSONAL_POLICY_V2,
	resolvePersonalRound,
} from "../src/agents/judgment-policy.ts";
import {
	EVALUATION_BUDGET_EXHAUSTED,
	JudgmentStore,
} from "../src/agents/judgment-store.ts";
import {
	assessmentInputDigest,
	parseAssessment,
	parseAssessmentSet,
	parseJudgmentSnapshotRef,
	parseResolutionRecord,
	snapshotDigest,
} from "../src/agents/judgment-validation.ts";
import { policyEvidenceFixture } from "./judgment-policy-evidence-fixture.ts";

const fixtures: ReturnType<typeof policyEvidenceFixture>[] = [];
afterEach(() => {
	for (const { fixture } of fixtures.splice(0)) fixture.close();
});

function deferredRecord(
	input: ReturnType<typeof policyEvidenceFixture>["input"],
	patch: Partial<ResolutionRecord> = {},
): ResolutionRecord {
	return parseResolutionRecord({
		schemaVersion: 1,
		roundId: input.snapshot.roundId,
		policyId: input.snapshot.policyId,
		policyRevision: input.snapshot.policyRevision,
		situation: input.snapshot.situation,
		order: [...input.policy.orders[input.snapshot.situation]],
		recommendations: { clotho: [], lachesis: [], atropos: [] },
		conflicts: [],
		excluded: [],
		abstentions: [],
		ranking: [],
		conceded: [],
		status: "deferred",
		holdReason: "assessment evidence incomplete",
		...patch,
	});
}

function v2Round(context: ReturnType<typeof policyEvidenceFixture>) {
	const { store, input } = context;
	const snapshot = parseJudgmentSnapshotRef({
		...input.snapshot,
		roundId: "policy-evidence-round-v2",
		policyRevision: PERSONAL_POLICY_V2.revision,
		sequence: input.snapshot.sequence + 1,
	});
	store.openRound(snapshot);
	const candidates = buildCandidateSet({
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		options: input.evidence.candidates.options,
		eligibility: input.evidence.candidates.eligibility,
		intentionRefs: input.evidence.candidates.intentionRefs,
	});
	const set = parseAssessmentSet({
		schemaVersion: 1,
		roundId: snapshot.roundId,
		snapshotDigest: snapshotDigest(snapshot),
		assessments: input.set.assessments.map((assessment) => {
			const ref = {
				snapshotDigest: snapshotDigest(snapshot),
				objectiveRef: assessment.objectiveRef,
				mechanismRevision: assessment.mechanismRevision,
			};
			return parseAssessment({
				...assessment,
				snapshotId: snapshot.roundId,
				...ref,
				inputDigest: assessmentInputDigest(ref),
			});
		}),
	});
	return {
		snapshot,
		candidates,
		set,
		input: {
			...input,
			policy: PERSONAL_POLICY_V2,
			snapshot,
			set,
			evidence: {
				candidates,
				lookupIntention: input.evidence.lookupIntention,
			},
		},
	};
}

test("deferred resolution with a partial assessment set records and reopens without a spec", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture } = context;
	// Only two of three module assessments are stored; no candidate set exists.
	const round = v2Round(context);
	for (const assessment of round.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	const record = deferredRecord(round.input);

	store.recordResolution(round.snapshot.roundId, record, null);
	expect(store.getRound(round.snapshot.roundId)?.status).toBe("deferred");

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(record);
	expect(reopened.getResolution(round.snapshot.roundId, "action")).toEqual(
		record,
	);
	expect(reopened.getSelectionSpec(round.snapshot.roundId)).toBeNull();
});

test("deferred resolution with a closed candidate set but partial assessments records", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture } = context;
	const round = v2Round(context);
	store.closeCandidateSet(round.candidates);
	for (const assessment of round.set.assessments.slice(0, 1))
		store.putAssessment(assessment);
	const record = deferredRecord(round.input, {
		holdReason: "module assessments incomplete",
	});

	store.recordResolution(round.snapshot.roundId, record, null);

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getRound(round.snapshot.roundId)?.status).toBe("deferred");
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(record);
	expect(reopened.getSelectionSpec(round.snapshot.roundId)).toBeNull();
});

test("deferred resolution with no candidates and no assessments records", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store } = context;
	const round = v2Round(context);
	const record = deferredRecord(round.input, {
		holdReason: "no candidate evidence",
	});

	store.recordResolution(round.snapshot.roundId, record, null);
	expect(store.getRound(round.snapshot.roundId)?.status).toBe("deferred");
	expect(store.getResolution(round.snapshot.roundId)).toEqual(record);
});

test("a revision-1 incomplete round ends held and never deferred", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	expect(input.snapshot.policyRevision).toBe(1);
	for (const assessment of input.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	// Revision 1 declares no terminal receipt, so its rounds stay retryable.
	expect(() =>
		store.recordResolution(input.snapshot.roundId, deferredRecord(input), null),
	).toThrow("incomplete assessment set");
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("open");

	const held = deferredRecord(input, {
		status: "held",
		holdReason: "awaiting remaining module",
	});
	store.recordResolution(input.snapshot.roundId, held, null);
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("held");
	expect(store.getResolution(input.snapshot.roundId)).toEqual(held);
});

test("held resolution with a partial assessment set still records", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	for (const assessment of input.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	const record = deferredRecord(input, {
		status: "held",
		holdReason: "awaiting remaining module",
	});

	store.recordResolution(input.snapshot.roundId, record, null);
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("held");
	expect(store.getResolution(input.snapshot.roundId)).toEqual(record);
});

test("resolved status with an incomplete assessment set is rejected", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	for (const assessment of input.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	const optionKey =
		input.evidence.candidates.options[0]?.optionKey ?? "unknown";
	const resolved = deferredRecord(input, {
		status: "resolved",
		holdReason: null,
		ranking: [{ optionKey, rank: 1 }],
	});

	expect(() =>
		store.recordResolution(input.snapshot.roundId, resolved, null),
	).toThrow();
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("open");
	expect(store.getResolution(input.snapshot.roundId)).toBeNull();
});

test("a non-null spec alongside an incomplete assessment set is rejected", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	store.closeCandidateSet(input.evidence.candidates);
	for (const assessment of input.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	// A spec is only meaningful for a resolved record; binding one to a
	// deferred receipt on a partial set must fail before any write.
	const resolved = resolvePersonalRound(input);
	if (resolved.spec === null) throw Error("fixture must resolve");
	const record = deferredRecord(input);

	expect(() =>
		store.recordResolution(input.snapshot.roundId, record, resolved.spec),
	).toThrow();
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("open");
	expect(store.getResolution(input.snapshot.roundId)).toBeNull();
});

for (const field of ["ranking", "conceded", "conflicts"] as const) {
	test(`incomplete deferred with a nonempty ${field} claim is rejected`, () => {
		const context = policyEvidenceFixture();
		fixtures.push(context);
		const { store, input } = context;
		const round = v2Round(context);
		for (const assessment of round.set.assessments.slice(0, 2))
			store.putAssessment(assessment);
		const optionKey =
			input.evidence.candidates.options[0]?.optionKey ?? "unknown";
		const patch: Partial<ResolutionRecord> =
			field === "ranking"
				? { ranking: [{ optionKey, rank: 1 }] }
				: field === "conceded"
					? { conceded: [{ moduleKind: "clotho", optionKey }] }
					: {
							conflicts: [
								{
									optionKey,
									stances: {
										clotho: "prefer",
										lachesis: "accept",
										atropos: "accept",
									},
								},
							],
						};
		const record = deferredRecord(round.input, patch);

		expect(() =>
			store.recordResolution(round.snapshot.roundId, record, null),
		).toThrow();
		expect(store.getRound(round.snapshot.roundId)?.status).toBe("open");
		expect(store.getResolution(round.snapshot.roundId)).toBeNull();
	});
}

test("full candidate and assessment evidence still policy-replays", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture, input } = context;
	store.closeCandidateSet(input.evidence.candidates);
	for (const assessment of input.set.assessments)
		store.putAssessment(assessment);
	const result = resolvePersonalRound(input);

	store.recordResolution(
		input.snapshot.roundId,
		result.resolution,
		result.spec,
	);

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(input.snapshot.roundId)).toEqual(
		result.resolution,
	);
	expect(reopened.getSelectionSpec(input.snapshot.roundId)).toEqual(
		result.spec,
	);
});

test("a revision-2 snapshot replays against the frozen v2 policy", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture } = context;
	const round = v2Round(context);
	// Under v2 an unavailable module opinion on a remaining candidate holds the
	// round; under v1 that module would be dropped and the round resolved.
	const target = round.set.assessments.find(
		(assessment) => assessment.moduleKind === "lachesis",
	);
	const opinion = target?.objectiveAssessments[0];
	if (!opinion) throw Error("missing fixture opinion");
	opinion.stance = "unavailable";
	opinion.unavailableReason = "insufficient_evidence";
	store.closeCandidateSet(round.candidates);
	for (const assessment of round.set.assessments)
		store.putAssessment(assessment);
	const result = resolvePersonalRound(round.input);
	expect(result.resolution.status).toBe("held");
	expect(result.spec).toBeNull();

	store.recordResolution(
		round.snapshot.roundId,
		result.resolution,
		result.spec,
	);

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(
		result.resolution,
	);
	expect(reopened.getSelectionSpec(round.snapshot.roundId)).toBeNull();
});

test("mixed v1 and v2 rounds replay under their own frozen revisions", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture, input } = context;
	// Round 1: v1 resolves normally with full evidence.
	store.closeCandidateSet(input.evidence.candidates);
	for (const assessment of input.set.assessments)
		store.putAssessment(assessment);
	const v1 = resolvePersonalRound(input);
	store.recordResolution(input.snapshot.roundId, v1.resolution, v1.spec);
	// Round 2: v2 holds on an unavailable opinion.
	const round = v2Round(context);
	const target = round.set.assessments.find(
		(assessment) => assessment.moduleKind === "atropos",
	);
	const opinion = target?.objectiveAssessments[0];
	if (!opinion) throw Error("missing fixture opinion");
	opinion.stance = "unavailable";
	opinion.unavailableReason = "insufficient_evidence";
	store.closeCandidateSet(round.candidates);
	for (const assessment of round.set.assessments)
		store.putAssessment(assessment);
	const v2 = resolvePersonalRound(round.input);
	expect(v2.resolution.status).toBe("held");
	store.recordResolution(round.snapshot.roundId, v2.resolution, v2.spec);

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(input.snapshot.roundId)).toEqual(v1.resolution);
	expect(reopened.getSelectionSpec(input.snapshot.roundId)).toEqual(v1.spec);
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(v2.resolution);
	expect(reopened.getRound(round.snapshot.roundId)?.status).toBe("held");
});

function v2HeldRound(context: ReturnType<typeof policyEvidenceFixture>) {
	const { store } = context;
	const round = v2Round(context);
	const target = round.set.assessments.find(
		(assessment) => assessment.moduleKind === "lachesis",
	);
	const opinion = target?.objectiveAssessments[0];
	if (!opinion) throw Error("missing fixture opinion");
	opinion.stance = "unavailable";
	opinion.unavailableReason = "insufficient_evidence";
	store.closeCandidateSet(round.candidates);
	for (const assessment of round.set.assessments)
		store.putAssessment(assessment);
	const result = resolvePersonalRound(round.input);
	if (result.resolution.status !== "held" || result.spec !== null)
		throw Error("v2 fixture must hold");
	return { ...round, held: result.resolution };
}

test("a replayed v2 hold converts to terminal deferred on budget exhaustion", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture } = context;
	const round = v2HeldRound(context);
	const record = parseResolutionRecord({
		...round.held,
		status: "deferred",
		holdReason: EVALUATION_BUDGET_EXHAUSTED,
	});

	store.recordResolution(round.snapshot.roundId, record, null);

	expect(store.getRound(round.snapshot.roundId)?.status).toBe("deferred");
	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(record);
	expect(reopened.getSelectionSpec(round.snapshot.roundId)).toBeNull();
});

test("budget exhaustion preserves replayed abstentions and rejects field drift", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store } = context;
	const round = v2HeldRound(context);
	// The replayed hold carries the unavailable opinion as an abstention; the
	// converted record must keep it verbatim.
	expect(round.held.abstentions.length).toBeGreaterThan(0);
	const drifted = parseResolutionRecord({
		...round.held,
		abstentions: [],
		status: "deferred",
		holdReason: EVALUATION_BUDGET_EXHAUSTED,
	});
	expect(() =>
		store.recordResolution(round.snapshot.roundId, drifted, null),
	).toThrow();
	const wrongReason = parseResolutionRecord({
		...round.held,
		status: "deferred",
		holdReason: "host gave up",
	});
	expect(() =>
		store.recordResolution(round.snapshot.roundId, wrongReason, null),
	).toThrow();
	expect(store.getRound(round.snapshot.roundId)?.status).toBe("open");
});

test("a replayed resolved record is never converted to deferred", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	store.closeCandidateSet(input.evidence.candidates);
	for (const assessment of input.set.assessments)
		store.putAssessment(assessment);
	const result = resolvePersonalRound(input);
	if (result.resolution.status !== "resolved")
		throw Error("fixture must resolve");
	const record = parseResolutionRecord({
		...result.resolution,
		status: "deferred",
		holdReason: EVALUATION_BUDGET_EXHAUSTED,
	});

	expect(() =>
		store.recordResolution(input.snapshot.roundId, record, null),
	).toThrow();
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("open");
	expect(store.getResolution(input.snapshot.roundId)).toBeNull();
});

test("a replayed revision-1 hold is never converted by budget exhaustion", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input } = context;
	// The eligible option loses one module opinion, so revision 1 also holds.
	const target = input.set.assessments.find((a) => a.moduleKind === "lachesis");
	if (!target) throw Error("missing fixture assessment");
	target.objectiveAssessments = [];
	store.closeCandidateSet(input.evidence.candidates);
	for (const assessment of input.set.assessments)
		store.putAssessment(assessment);
	const replayed = resolvePersonalRound(input);
	expect(input.snapshot.policyRevision).toBe(1);
	expect(replayed.resolution.status).toBe("held");
	const record = parseResolutionRecord({
		...replayed.resolution,
		status: "deferred",
		holdReason: EVALUATION_BUDGET_EXHAUSTED,
	});

	expect(() =>
		store.recordResolution(input.snapshot.roundId, record, null),
	).toThrow("resolution policy replay mismatch");
	expect(store.getRound(input.snapshot.roundId)?.status).toBe("open");
	expect(store.getResolution(input.snapshot.roundId)).toBeNull();
});

test("an incomplete deferred receipt rejects unsupported arbitration fields", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, input, option } = context;
	const round = v2Round(context);
	// Only clotho and lachesis are stored, and no candidate set exists.
	for (const assessment of round.set.assessments.slice(0, 2))
		store.putAssessment(assessment);
	const optionKey = option.optionKey;
	for (const patch of [
		{
			excluded: [
				{
					optionKey,
					stage: "host_eligibility" as const,
					byModule: null,
					reason: "host ineligible",
				},
			],
		},
		{
			abstentions: [
				{ optionKey, moduleKind: "lachesis" as const, reason: "unavailable" },
			],
		},
		// atropos has no stored assessment, so it can recommend nothing.
		{ recommendations: { clotho: [], lachesis: [], atropos: [optionKey] } },
		// The declared order for this round's situation is not the transition one.
		{ order: [...PERSONAL_POLICY_V2.orders.transition] },
	]) {
		const record = deferredRecord(round.input, patch);
		expect(() =>
			store.recordResolution(round.snapshot.roundId, record, null),
		).toThrow("incomplete deferred asserts unsupported arbitration");
		expect(store.getRound(round.snapshot.roundId)?.status).toBe("open");
		expect(store.getResolution(round.snapshot.roundId)).toBeNull();
	}
	expect(input.snapshot.policyRevision).toBe(1);
});

test("an incomplete receipt keeps the recommendations its stored assessments prove", () => {
	const context = policyEvidenceFixture();
	fixtures.push(context);
	const { store, path, fixture, option } = context;
	const round = v2Round(context);
	const stored = round.set.assessments.slice(0, 2).map((assessment) =>
		parseAssessment({
			...assessment,
			recommendedOptionKeys:
				assessment.moduleKind === "clotho" ? [option.optionKey] : [],
		}),
	);
	for (const assessment of stored) store.putAssessment(assessment);
	const record = deferredRecord(round.input, {
		recommendations: { clotho: [option.optionKey], lachesis: [], atropos: [] },
	});

	store.recordResolution(round.snapshot.roundId, record, null);

	const reopened = fixture.keep(new JudgmentStore(path));
	expect(reopened.getResolution(round.snapshot.roundId)).toEqual(record);
	expect(reopened.getSelectionSpec(round.snapshot.roundId)).toBeNull();
});
