import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as api from "../src/agents/index.ts";
import { Fixture } from "./fixture.ts";

let fixture: Fixture;
let path: string;
let store: api.JudgmentStore;
let snapshot: api.JudgmentSnapshotRef;
let assessments: api.Assessment[];
beforeEach(() => {
	fixture = new Fixture();
	path = join(fixture.dir, "dialogue.sqlite");
	store = new api.JudgmentStore(path);
	for (const moduleKind of api.MODULE_KINDS) {
		const ref = store.putObjectiveProfile({
			schemaVersion: 1,
			objectiveId: moduleKind,
			moduleKind,
			revision: 1,
			objective: "Compare",
			comparisonCriteria: [],
			reconsiderationConditions: [],
		});
		store.activateObjectiveProfile("agent", "scope", ref);
	}
	const refs = store.activeObjectiveProfiles("agent", "scope");
	if (!refs) throw Error("missing profiles");
	snapshot = {
		schemaVersion: 1,
		roundId: "dialogue",
		agentId: "agent",
		scopeId: "scope",
		sourceRefs: [{ kind: "request", id: "request", revision: 0 }],
		workingRevision: 0,
		instructionRevision: 0,
		policyId: "personal.v1",
		policyRevision: 1,
		identityRevision: 0,
		domainRevisions: {},
		intentionRevision: store.intentionRevision("agent", "scope"),
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "user_request",
		clockId: "clock",
		sequence: 1,
		bindingGeneration: 0,
	};
	assessments = api.MODULE_KINDS.map((moduleKind) => {
		const input = {
			snapshotDigest: api.snapshotDigest(snapshot),
			objectiveRef: refs[moduleKind],
			mechanismRevision: 1,
		};
		return api.parseAssessment({
			schemaVersion: 1,
			moduleKind,
			snapshotId: snapshot.roundId,
			...input,
			inputDigest: api.assessmentInputDigest(input),
			completeText: `Initial ${moduleKind} judgment`,
			evidenceRefs: ["source"],
			proposedOptionKeys: [],
			objectiveAssessments: [],
			recommendedOptionKeys: [],
			detail: {
				kind: {
					clotho: "forecasts",
					lachesis: "values",
					atropos: "continuity",
				}[moduleKind],
				body: {},
			},
			diagnostics: {},
		});
	});
});
afterEach(() => {
	store.close();
	fixture.close();
});
function record() {
	return {
		schemaVersion: 2 as const,
		mode: "dialogue" as const,
		roundId: snapshot.roundId,
		snapshotDigest: api.snapshotDigest(snapshot),
		objectiveProfileRefs: snapshot.objectiveProfileRefs,
		assessmentDigests: {
			clotho: api.judgmentDigest(assessments[0]),
			lachesis: api.judgmentDigest(assessments[1]),
			atropos: api.judgmentDigest(assessments[2]),
		},
		policyId: snapshot.policyId,
		policyRevision: snapshot.policyRevision,
		situation: snapshot.situation,
		requestId: "request",
		requestDigest: api.judgmentDigest({ request: "original" }),
		sourceDigest: api.judgmentDigest({ source: "original" }),
		recommendations: {
			clotho: "Explain likely outcomes",
			lachesis: "Respect the user's priorities",
			atropos: "Retain the original commitment",
		},
		alignment: "aligned" as const,
		conflicts: [],
		concessions: [],
		synthesis: "A textual response synthesis",
		rationale: "Reasons for this synthesis",
		status: "resolved" as const,
		holdReason: null,
	};
}
function seed(count = 3) {
	store.openRound(snapshot);
	for (const a of assessments.slice(0, count)) store.putAssessment(a);
}
function reopen() {
	store.close();
	store = new api.JudgmentStore(path);
}
function db() {
	return fixture.keep(new DatabaseSync(path));
}

test("3996179135 action v1 bytes and digest remain unchanged alongside dialogue v2", () => {
	const actionSnapshot = {
		...snapshot,
		roundId: "historic-action",
		sequence: 0,
	};
	const action = api.parseResolutionRecord({
		schemaVersion: 1,
		roundId: actionSnapshot.roundId,
		policyId: snapshot.policyId,
		policyRevision: snapshot.policyRevision,
		situation: snapshot.situation,
		order: ["atropos", "clotho", "lachesis"],
		recommendations: { clotho: [], lachesis: [], atropos: [] },
		conflicts: [],
		excluded: [],
		abstentions: [
			{
				optionKey: "historical",
				moduleKind: "clotho",
				reason: "historic diagnostic text",
			},
		],
		ranking: [],
		conceded: [],
		status: "held",
		holdReason: "historical missing input",
	});
	store.openRound(actionSnapshot);
	store.recordResolution(actionSnapshot.roundId, action, null);
	const sql = db();
	const original = sql
		.prepare("SELECT body,digest FROM resolution_records WHERE round_id = ?")
		.get(actionSnapshot.roundId);
	seed();
	store.recordResolution(snapshot.roundId, record(), null);
	reopen();
	expect(api.parseStoredResolutionRecord(action)).toEqual(action);
	expect(store.getResolution(actionSnapshot.roundId, "action")).toEqual(action);
	expect(store.getResolution(actionSnapshot.roundId, "dialogue")).toBeNull();
	expect(store.dialogueJudgmentRef(actionSnapshot.roundId)).toBeNull();
	expect(store.getResolution(snapshot.roundId, "action")).toBeNull();
	expect(
		sql
			.prepare("SELECT body,digest FROM resolution_records WHERE round_id = ?")
			.get(actionSnapshot.roundId),
	).toEqual(original);
	expect(original?.["digest"]).toBe(api.judgmentDigest(action));
});

test("3996179135 dialogue v2 golden round-trip retains prose and immutable provenance", () => {
	const original = record();
	const parsed = api.parseDialogueResolutionRecord(
		JSON.parse(JSON.stringify(original)),
	);
	expect(parsed).toEqual(original);
	expect(api.judgmentDigest(parsed)).toBe(api.judgmentDigest(original));
	expect(api.parseStoredResolutionRecord(original)).toEqual(original);
	const {
		schemaVersion: _version,
		mode: _mode,
		roundId: _round,
		snapshotDigest: _digest,
		objectiveProfileRefs: _refs,
		assessmentDigests: _assessments,
		policyId: _policy,
		policyRevision: _revision,
		situation: _situation,
		...input
	} = original;
	expect(
		api.buildDialogueResolution({ ...input, snapshot, assessments }),
	).toEqual(original);
});
for (const change of [
	{ schemaVersion: 1 },
	{ schemaVersion: 3 },
	{ mode: "action" },
	{ extra: true },
	{ ranking: [] },
	{ candidates: [] },
	{ assessmentSetDigest: "fake" },
	{ selectionSpec: null },
	{ assessmentDigests: { clotho: "a", lachesis: "b" } },
	{ assessmentDigests: { clotho: null, lachesis: null, atropos: null } },
	{ recommendations: { clotho: "text", lachesis: "text" } },
	{ rationale: " " },
	{ synthesis: "" },
	{ alignment: "conflicted" },
])
	test(`3996179135 strict dialogue rejects ${JSON.stringify(change)}`, () => {
		expect(() =>
			api.parseDialogueResolutionRecord({ ...record(), ...change }),
		).toThrow();
	});

test("3996179135 resolved candidate-free dialogue persists with zero selection/candidate rows and reconstructible ref", () => {
	seed();
	const original = record();
	store.recordResolution(snapshot.roundId, original, null);
	const ref = store.dialogueJudgmentRef(snapshot.roundId);
	expect(ref).not.toBeNull();
	if (!ref) throw Error("missing dialogue ref");
	expect(api.parseDialogueJudgmentRef(JSON.parse(JSON.stringify(ref)))).toEqual(
		ref,
	);
	expect(ref.resolutionDigest).toBe(api.judgmentDigest(original));
	expect(ref.assessmentDigests).toEqual(original.assessmentDigests);
	expect(ref.requestDigest).toBe(original.requestDigest);
	expect(ref.sourceDigest).toBe(original.sourceDigest);
	expect(() => store.validateDialogueJudgmentRef(ref)).not.toThrow();
	for (const changed of [
		{ ...ref, schemaVersion: 2 },
		{ ...ref, extra: true },
		{
			...ref,
			assessmentDigests: {
				clotho: ref.assessmentDigests.clotho,
				lachesis: ref.assessmentDigests.lachesis,
			},
		},
		{ ...ref, refDigest: api.judgmentDigest("wrong") },
	])
		expect(() => api.parseDialogueJudgmentRef(changed)).toThrow();
	for (const field of [
		"requestDigest",
		"sourceDigest",
		"snapshotDigest",
		"resolutionDigest",
	] as const) {
		const changed = { ...ref, [field]: api.judgmentDigest("tampered") };
		const forged = {
			...changed,
			refDigest: api.judgmentDigest({ ...changed, refDigest: undefined }),
		};
		expect(() => store.validateDialogueJudgmentRef(forged)).toThrow();
	}
	const sql = db();
	for (const table of ["candidate_sets", "selection_specs"])
		expect(sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({
			n: 0,
		});
	expect(sql.prepare("SELECT count(*) AS n FROM assessments").get()).toEqual({
		n: 3,
	});
	const first = assessments[0];
	if (!first) throw Error("missing fixture assessment");
	expect(() => store.putAssessment(first)).toThrow("not open");
	reopen();
	expect(store.getResolution(snapshot.roundId)).toEqual(original);
	expect(store.getResolution(snapshot.roundId, "dialogue")).toEqual(original);
	expect(store.dialogueJudgmentRef(snapshot.roundId)).toEqual(ref);
	expect(store.assessmentSet(snapshot.roundId).assessments).toEqual(
		assessments,
	);
	expect(store.getSelectionSpec(snapshot.roundId)).toBeNull();
});

test("3996179135 dialogue forbids SelectionSpec and action candidate closure atomically", () => {
	seed();
	const value = record();
	const specBody = {
		schemaVersion: 1,
		roundId: snapshot.roundId,
		snapshotDigest: api.snapshotDigest(snapshot),
		assessmentSetDigest: api.judgmentDigest(
			store.assessmentSet(snapshot.roundId),
		),
		objectiveProfileRefs: snapshot.objectiveProfileRefs,
		resolutionDigest: api.judgmentDigest(value),
		policyId: snapshot.policyId,
		policyRevision: snapshot.policyRevision,
		situation: snapshot.situation,
		lambda: 0,
		candidates: [{ optionKey: "fake", p0: 1, b: null }],
		eligibleDigest: api.judgmentDigest(["fake"]),
	};
	const spec = api.parseSelectionSpec({
		...specBody,
		specDigest: api.judgmentDigest(specBody),
	});
	expect(() => store.recordResolution(snapshot.roundId, value, spec)).toThrow();
	expect(store.getResolution(snapshot.roundId)).toBeNull();
	const option = api.buildCanonicalOption({
		kind: "noop",
		actor: { agentId: "agent", scopeId: "scope" },
		targetId: null,
		args: {},
		preconditions: { kind: "noop", reason: "wait" },
	});
	store.closeCandidateSet(
		api.buildCandidateSet({
			roundId: snapshot.roundId,
			snapshotDigest: api.snapshotDigest(snapshot),
			options: [option],
			eligibility: [
				{ optionKey: option.optionKey, eligible: true, reason: null },
			],
			intentionRefs: [],
		}),
	);
	expect(() => store.recordResolution(snapshot.roundId, value, null)).toThrow();
	expect(store.getRound(snapshot.roundId)?.status).toBe("open");
});
for (const tamper of [
	"missing",
	"assessmentDigest",
	"objective",
	"snapshot",
	"request",
] as const) {
	test(`3996179135 dialogue rejects ${tamper} on write and rehashed historical restore`, () => {
		seed();
		const original = record();
		const changed = structuredClone(original);
		if (tamper === "assessmentDigest")
			changed.assessmentDigests.clotho = api.judgmentDigest("changed");
		if (tamper === "objective")
			changed.objectiveProfileRefs.clotho.digest =
				api.judgmentDigest("changed");
		if (tamper === "snapshot")
			changed.snapshotDigest = api.judgmentDigest("changed");
		if (tamper === "request") changed.requestId = "other-request";
		if (tamper === "missing")
			db().exec("DELETE FROM assessments WHERE module_kind = 'atropos'");
		expect(() =>
			store.recordResolution(snapshot.roundId, changed, null),
		).toThrow();
		expect(store.getResolution(snapshot.roundId)).toBeNull();
		if (tamper === "missing") {
			const third = assessments[2];
			if (!third) throw Error("missing fixture assessment");
			store.putAssessment(third);
		}
		store.recordResolution(snapshot.roundId, original, null);
		if (tamper === "missing")
			db().exec("DELETE FROM assessments WHERE module_kind = 'atropos'");
		else
			db()
				.prepare("UPDATE resolution_records SET body = ?, digest = ?")
				.run(JSON.stringify(changed), api.judgmentDigest(changed));
		expect(() => store.getResolution(snapshot.roundId)).toThrow();
		reopen();
		expect(() => store.dialogueJudgmentRef(snapshot.roundId)).toThrow();
	});
}

test("3996179135 incomplete held dialogue explicitly preserves only available module refs", () => {
	seed(2);
	const value = {
		...record(),
		status: "held" as const,
		holdReason: "missing module",
		alignment: "incomplete" as const,
		assessmentDigests: { ...record().assessmentDigests, atropos: null },
		recommendations: { ...record().recommendations, atropos: null },
	};
	store.recordResolution(snapshot.roundId, value, null);
	reopen();
	expect(store.getResolution(snapshot.roundId)).toEqual(value);
	expect(store.dialogueJudgmentRef(snapshot.roundId)).toBeNull();
});

test("3996179135 conflicted dialogue retains textual conflict/concession reasons without option keys", () => {
	seed();
	const value = {
		...record(),
		alignment: "conflicted" as const,
		conflicts: [
			{
				moduleKind: "clotho" as const,
				reason: "Forecast conflicts with continuity",
			},
		],
		concessions: [
			{
				moduleKind: "lachesis" as const,
				reason: "Give continuity priority here",
			},
		],
	};
	store.recordResolution(snapshot.roundId, value, null);
	reopen();
	expect(store.getResolution(snapshot.roundId)).toEqual(value);
});

test("3998853070 dialogue checks intention currentness only on resolution, not history", () => {
	seed();
	const original = record();
	store.recordResolution(snapshot.roundId, original, null);
	const second = { ...snapshot, roundId: "second", sequence: 2 };
	store.openRound(second);
	store.putIntention({
		schemaVersion: 1,
		intentionId: "new-intention",
		agentId: snapshot.agentId,
		scopeId: snapshot.scopeId,
		revision: 0,
		kind: "user_commitment",
		purposeRef: "purpose",
		text: "New commitment",
		acceptance: {
			sourceRef: "request",
			acceptedBy: "user",
			policyRevision: 1,
			acceptedAt: "2026-09-12T00:00:00.000Z",
		},
		priority: 0,
		deadline: null,
		completionCondition: "receipt",
		abortConditions: [],
		relatedIntentions: [],
		status: "proposed",
		history: [],
	});
	expect(() =>
		store.recordResolution(
			second.roundId,
			{ ...original, roundId: second.roundId },
			null,
		),
	).toThrow("stale intention revision");
	expect(store.getRound(second.roundId)?.status).toBe("open");
	expect(store.getResolution(second.roundId)).toBeNull();
	reopen();
	expect(store.getResolution(snapshot.roundId)).toEqual(original);
	expect(store.dialogueJudgmentRef(snapshot.roundId)).not.toBeNull();
});

test("3996179135 action-shaped initial assessment cannot masquerade as dialogue", () => {
	const first = assessments[0];
	if (!first) throw Error("missing fixture assessment");
	const changed = api.parseAssessment({
		...first,
		proposedOptionKeys: ["fake-option"],
	});
	assessments[0] = changed;
	seed();
	expect(() =>
		store.recordResolution(snapshot.roundId, record(), null),
	).toThrow("dialogue forbids action assessments");
	expect(store.getResolution(snapshot.roundId)).toBeNull();
});

test("3996179135 rehashed assessment rewrite disagrees with immutable dialogue refs", () => {
	seed();
	store.recordResolution(snapshot.roundId, record(), null);
	const first = assessments[0];
	if (!first) throw Error("missing fixture assessment");
	const changed = { ...first, completeText: "Rewritten initial opinion" };
	db()
		.prepare(
			"UPDATE assessments SET body = ?, digest = ? WHERE module_kind = 'clotho'",
		)
		.run(JSON.stringify(changed), api.judgmentDigest(changed));
	expect(() => store.getResolution(snapshot.roundId)).toThrow(
		"dialogue assessment digest mismatch",
	);
	reopen();
	expect(() => store.getResolution(snapshot.roundId)).toThrow(
		"dialogue assessment digest mismatch",
	);
});

test("3998853057 dialogue rejects new stale objective resolution but keeps already resolved history", () => {
	seed();
	const original = record();
	store.recordResolution(snapshot.roundId, original, null);
	const second = { ...snapshot, roundId: "second", sequence: 2 };
	store.openRound(second);
	const profile = store.getObjectiveProfile("clotho", 1);
	if (!profile) throw Error("missing fixture profile");
	const next = store.putObjectiveProfile({ ...profile, revision: 2 });
	store.activateObjectiveProfile("agent", "scope", next);
	expect(() =>
		store.recordResolution(
			second.roundId,
			{ ...original, roundId: second.roundId },
			null,
		),
	).toThrow("stale objective profile refs");
	reopen();
	expect(store.getResolution(snapshot.roundId)).toEqual(original);
	expect(store.dialogueJudgmentRef(snapshot.roundId)).not.toBeNull();
	expect(store.getResolution(second.roundId)).toBeNull();
});
