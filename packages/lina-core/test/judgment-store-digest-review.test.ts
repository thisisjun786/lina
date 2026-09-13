import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type Assessment,
	assessmentInputDigest,
	buildCandidateSet,
	buildCanonicalOption,
	type IntentionRecord,
	type IntentionTransition,
	type JudgmentSnapshotRef,
	JudgmentStore,
	judgmentDigest,
	MODULE_KINDS,
	type ModuleKind,
	type ObjectiveProfile,
	parseAssessment,
	parseAssessmentSet,
	parseIntentionRecord,
	parseJudgmentSnapshotRef,
	parseObjectiveProfile,
	parseResolutionRecord,
	parseSelectionSpec,
	type ResolutionRecord,
	type SelectionSpec,
	snapshotDigest,
} from "../src/agents/index.ts";

let dir: string;
let path: string;
let store: JudgmentStore;
let db: DatabaseSync;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-judgment-digest-"));
	path = join(dir, "judgment.sqlite");
	store = new JudgmentStore(path, { now: () => 1234 });
	db = new DatabaseSync(path);
});
afterEach(() => {
	db.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	expect(existsSync(dir)).toBe(false);
});
function reopen(): void {
	store.close();
	store = new JudgmentStore(path, { now: () => 1234 });
}
function profile(
	moduleKind: ModuleKind = "clotho",
	revision = 1,
): ObjectiveProfile {
	return {
		schemaVersion: 1,
		objectiveId: `objective-${moduleKind}`,
		moduleKind,
		revision,
		objective: "Compare fixture outcomes",
		comparisonCriteria: ["cost", "outcome"],
		reconsiderationConditions: ["new evidence"],
	};
}
function snapshot(
	store: JudgmentStore,
	roundId = "round-1",
	sequence = 1,
): JudgmentSnapshotRef {
	for (const module of MODULE_KINDS) {
		const ref = store.putObjectiveProfile(profile(module));
		store.activateObjectiveProfile("agent-1", "scope-1", ref);
	}
	const refs = store.activeObjectiveProfiles("agent-1", "scope-1");
	if (!refs) throw Error("fixture profiles missing");
	return parseJudgmentSnapshotRef({
		schemaVersion: 1,
		roundId,
		agentId: "agent-1",
		scopeId: "scope-1",
		sourceRefs: [],
		workingRevision: 2,
		instructionRevision: 1,
		policyId: "personal.v1",
		policyRevision: 1,
		identityRevision: 1,
		domainRevisions: { life: 0 },
		intentionRevision: 0,
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "user_request",
		clockId: "clock-1",
		sequence,
		bindingGeneration: 0,
	});
}
const optionA = buildCanonicalOption({
	kind: "noop",
	actor: { agentId: "agent-1", scopeId: "scope-1" },
	targetId: null,
	args: {},
	preconditions: { kind: "noop", reason: "fixture" },
});
const A = optionA.optionKey;
function closeCandidates(store: JudgmentStore, ref: JudgmentSnapshotRef) {
	store.closeCandidateSet(
		buildCandidateSet({
			roundId: ref.roundId,
			snapshotDigest: snapshotDigest(ref),
			options: [optionA],
			eligibility: [{ optionKey: A, eligible: true, reason: null }],
			intentionRefs: [],
		}),
	);
}

function assessment(
	ref: JudgmentSnapshotRef,
	moduleKind: ModuleKind,
	digest = snapshotDigest(ref),
): Assessment {
	const input = {
		snapshotDigest: digest,
		objectiveRef: ref.objectiveProfileRefs[moduleKind],
		mechanismRevision: 1,
	};
	return parseAssessment({
		schemaVersion: 1,
		moduleKind,
		snapshotId: ref.roundId,
		...input,
		inputDigest: assessmentInputDigest(input),
		completeText: "Fixture assessment",
		evidenceRefs: [],
		proposedOptionKeys: [A],
		objectiveAssessments: [
			{
				optionKey: A,
				stance: "prefer",
				severity: null,
				unavailableReason: null,
				gain: "gain",
				loss: "loss",
				uncertainty: "unknown",
				evidenceRefs: [],
			},
		],
		recommendedOptionKeys: [A],
		detail: {
			kind: { clotho: "forecasts", lachesis: "values", atropos: "continuity" }[
				moduleKind
			],
			body: { z: [{ b: 2, a: 1 }], a: true },
		},
		diagnostics: {},
	});
}
function resolution(
	ref: JudgmentSnapshotRef,
	status: ResolutionRecord["status"] = "resolved",
): ResolutionRecord {
	return parseResolutionRecord({
		schemaVersion: 1,
		roundId: ref.roundId,
		policyId: "personal.v1",
		policyRevision: 1,
		situation: ref.situation,
		order: ["atropos", "clotho", "lachesis"],
		recommendations: { clotho: [A], lachesis: [A], atropos: [A] },
		conflicts: [],
		excluded: [],
		abstentions: [],
		ranking: [{ optionKey: A, rank: 1 }],
		conceded: [],
		status,
		holdReason: status === "resolved" ? null : "no eligible candidate",
	});
}
function spec(
	ref: JudgmentSnapshotRef,
	record = resolution(ref),
): SelectionSpec {
	const body = {
		schemaVersion: 1,
		roundId: ref.roundId,
		snapshotDigest: snapshotDigest(ref),
		assessmentSetDigest: judgmentDigest(
			parseAssessmentSet({
				schemaVersion: 1,
				roundId: ref.roundId,
				snapshotDigest: snapshotDigest(ref),
				assessments: MODULE_KINDS.map((m) => assessment(ref, m)),
			}),
		),
		objectiveProfileRefs: ref.objectiveProfileRefs,
		resolutionDigest: judgmentDigest(record),
		policyId: record.policyId,
		policyRevision: record.policyRevision,
		situation: ref.situation,
		lambda: 0,
		candidates: [{ optionKey: A, p0: 1, b: null }],
		eligibleDigest: judgmentDigest([A]),
	};
	return parseSelectionSpec({ ...body, specDigest: judgmentDigest(body) });
}
function intention(intentionId = "intention-1"): IntentionRecord {
	return parseIntentionRecord({
		schemaVersion: 1,
		intentionId,
		agentId: "agent-1",
		scopeId: "scope-1",
		revision: 0,
		kind: "user_commitment",
		purposeRef: "purpose-1",
		text: "Complete fixture task",
		acceptance: {
			sourceRef: "request-1",
			acceptedBy: "user",
			policyRevision: 1,
			acceptedAt: "2026-09-11T00:00:00.000Z",
		},
		priority: 0,
		deadline: null,
		completionCondition: "Outcome receipt",
		abortConditions: [],
		relatedIntentions: [],
		status: "proposed",
		history: [],
	});
}
function transition(
	to: IntentionTransition["to"],
): Omit<IntentionTransition, "from"> {
	return {
		to,
		reason: "fixture transition",
		evidenceRef: "request-1",
		at: "2026-09-11T01:00:00.000Z",
	};
}

function seed() {
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const module of MODULE_KINDS)
		store.putAssessment(assessment(ref, module));
	store.putIntention(intention());
	return ref;
}
function replaceBody(table: string, value: unknown, where = "1 = 1"): void {
	expect(
		db
			.prepare(`UPDATE ${table} SET body = ? WHERE ${where}`)
			.run(JSON.stringify(value)).changes,
	).toBe(1);
}
function rehashSpec(selection: SelectionSpec): SelectionSpec {
	return parseSelectionSpec({
		...selection,
		specDigest: judgmentDigest({ ...selection, specDigest: undefined }),
	});
}

for (const tamper of ["body", "digest"] as const) {
	for (const action of [
		"get",
		"active",
		"put",
		"activate",
		"openRound",
	] as const) {
		test(`3995355426: objective ${tamper} mismatch rejects ${action} after reopen`, () => {
			const ref = seed();
			const changed = parseObjectiveProfile({
				...profile(),
				objective: "Different objective",
			});
			const expected = tamper === "body" ? changed : profile();
			if (tamper === "body")
				replaceBody("objective_profiles", changed, "module_kind = 'clotho'");
			else
				db.prepare(
					"UPDATE objective_profiles SET digest = ? WHERE module_kind = 'clotho'",
				).run(judgmentDigest(changed));
			reopen();
			const objectiveRef = {
				...ref.objectiveProfileRefs.clotho,
				digest: judgmentDigest(expected),
			};
			const before = db
				.prepare("SELECT * FROM objective_profile_active ORDER BY module_kind")
				.all();
			const run = {
				get: () =>
					store.getObjectiveProfile(expected.objectiveId, expected.revision),
				active: () => store.activeObjectiveProfiles(ref.agentId, ref.scopeId),
				put: () => store.putObjectiveProfile(expected),
				activate: () =>
					store.activateObjectiveProfile(
						ref.agentId,
						ref.scopeId,
						objectiveRef,
					),
				openRound: () =>
					store.openRound({
						...ref,
						roundId: "round-2",
						sequence: 2,
						objectiveProfileRefs: {
							...ref.objectiveProfileRefs,
							clotho: objectiveRef,
						},
					}),
			};
			expect(run[action]).toThrow("objective profile digest mismatch");
			expect(
				db
					.prepare(
						"SELECT * FROM objective_profile_active ORDER BY module_kind",
					)
					.all(),
			).toEqual(before);
			expect(() => store.getRound("round-2")).toThrow(
				"objective profile digest mismatch",
			);
			expect(
				db
					.prepare("SELECT round_id FROM rounds WHERE round_id = 'round-2'")
					.get(),
			).toBeUndefined();
		});
	}
	for (const action of ["get", "list", "filtered", "transition"] as const) {
		test(`3995355426: intention ${tamper} mismatch rejects ${action} after reopen`, () => {
			seed();
			const changed = parseIntentionRecord({
				...intention(),
				text: "Different commitment",
			});
			if (tamper === "body") replaceBody("intention_records", changed);
			else
				db.prepare("UPDATE intention_records SET digest = ?").run(
					judgmentDigest(changed),
				);
			reopen();
			const before = db.prepare("SELECT * FROM intention_records").all();
			const run = {
				get: () => store.getIntention("intention-1"),
				list: () => store.listIntentions("agent-1", "scope-1"),
				filtered: () => store.listIntentions("agent-1", "scope-1", "proposed"),
				transition: () =>
					store.transitionIntention("intention-1", transition("adopted"), 0),
			};
			expect(run[action]).toThrow("intention digest mismatch");
			expect(db.prepare("SELECT * FROM intention_records").all()).toEqual(
				before,
			);
			expect(
				db.prepare("SELECT count(*) AS n FROM intention_transitions").get(),
			).toEqual({ n: 0 });
		});
	}
	for (const target of ["resolution", "selection"] as const) {
		test(`3995355426: ${target} ${tamper} mismatch rejected after reopen`, () => {
			const ref = seed();
			const record = resolution(ref);
			const selection = spec(ref);
			store.recordResolution(ref.roundId, record, selection);
			const changedRecord = parseResolutionRecord({
				...record,
				ranking: [{ optionKey: A, rank: 2 }],
			});
			// Keep the embedded selection digest valid: only its persisted anchor is stale.
			const changedSelection = rehashSpec({ ...selection, lambda: 1 });
			if (target === "resolution") {
				if (tamper === "body") replaceBody("resolution_records", changedRecord);
				else
					db.prepare("UPDATE resolution_records SET digest = ?").run(
						judgmentDigest(changedRecord),
					);
			} else {
				if (tamper === "body") replaceBody("selection_specs", changedSelection);
				else
					db.prepare("UPDATE selection_specs SET spec_digest = ?").run(
						changedSelection.specDigest,
					);
			}
			reopen();
			expect(() =>
				target === "resolution"
					? store.getResolution(ref.roundId)
					: store.getSelectionSpec(ref.roundId),
			).toThrow(
				`${target === "resolution" ? "resolution" : "selection spec"} digest mismatch`,
			);
		});
	}
}

for (const tamper of [
	"body",
	"digest",
	"input_digest",
	"snapshot_digest",
] as const) {
	for (const action of ["assessmentSet", "recordResolution"] as const) {
		test(`3995355426: assessment ${tamper} mismatch rejects ${action} after reopen`, () => {
			const ref = seed();
			const original = assessment(ref, "clotho");
			const changed = parseAssessment({
				...original,
				completeText: "Different assessment",
			});
			if (tamper === "body")
				replaceBody("assessments", changed, "module_kind = 'clotho'");
			else
				db.prepare(
					`UPDATE assessments SET ${tamper} = ? WHERE module_kind = 'clotho'`,
				).run(judgmentDigest(changed));
			// A matching downstream digest must not bless corruption in its source rows.
			const expected = parseAssessmentSet({
				schemaVersion: 1,
				roundId: ref.roundId,
				snapshotDigest: snapshotDigest(ref),
				assessments: MODULE_KINDS.map((module) =>
					module === "clotho" && tamper === "body"
						? changed
						: assessment(ref, module),
				),
			});
			const selection = rehashSpec({
				...spec(ref),
				assessmentSetDigest: judgmentDigest(expected),
			});
			reopen();
			expect(() =>
				action === "assessmentSet"
					? store.assessmentSet(ref.roundId)
					: store.recordResolution(ref.roundId, resolution(ref), selection),
			).toThrow(
				tamper === "input_digest"
					? "assessment input digest mismatch"
					: tamper === "snapshot_digest"
						? "assessment snapshot digest mismatch"
						: "assessment digest mismatch",
			);
			// A corrupt ledger fails closed even for queries that would return no rows.
			expect(() => store.getResolution(ref.roundId)).toThrow(
				/assessment .*mismatch/,
			);
			expect(db.prepare("SELECT status FROM rounds").get()).toEqual({
				status: "open",
			});
			expect(
				db.prepare("SELECT count(*) AS n FROM resolution_records").get(),
			).toEqual({ n: 0 });
			expect(
				db.prepare("SELECT count(*) AS n FROM selection_specs").get(),
			).toEqual({ n: 0 });
		});
	}
}

test("3995355426: parser-normalized digests and valid lifecycle survive reopen", () => {
	const ref = seed();
	const record = resolution(ref);
	const selection = spec(ref);
	store.recordResolution(ref.roundId, record, selection);
	const initial = parseIntentionRecord({
		...intention("intention-2"),
		abortConditions: ["a", "b"],
	});
	store.putIntention(initial);
	const changed = {
		...profile(),
		comparisonCriteria: [...profile().comparisonCriteria].reverse(),
	};
	expect(judgmentDigest(changed)).not.toBe(
		judgmentDigest(parseObjectiveProfile(changed)),
	);
	replaceBody("objective_profiles", changed, "module_kind = 'clotho'");
	const originalAssessment = parseAssessment({
		...assessment(ref, "clotho"),
		evidenceRefs: ["a", "b"],
	});
	// Update both anchor and body to a valid canonical assessment, then reorder its set-like list.
	db.prepare(
		"UPDATE assessments SET digest = ?, body = ? WHERE module_kind = 'clotho'",
	).run(
		judgmentDigest(originalAssessment),
		JSON.stringify({ ...originalAssessment, evidenceRefs: ["b", "a"] }),
	);
	const originalResolution = record;
	db.prepare("UPDATE resolution_records SET digest = ?, body = ?").run(
		judgmentDigest(originalResolution),
		JSON.stringify(
			Object.fromEntries(Object.entries(originalResolution).reverse()),
		),
	);
	replaceBody(
		"intention_records",
		{ ...initial, abortConditions: ["b", "a"] },
		"intention_id = 'intention-2'",
	);
	// Selection has no sortable set-like list; JSON key order/whitespace are not digest input.
	// Keep the downstream anchor consistent with the changed assessment evidence.
	const normalizedSelection = rehashSpec({
		...selection,
		assessmentSetDigest: judgmentDigest(
			parseAssessmentSet({
				schemaVersion: 1,
				roundId: ref.roundId,
				snapshotDigest: snapshotDigest(ref),
				assessments: MODULE_KINDS.map((module) =>
					module === "clotho" ? originalAssessment : assessment(ref, module),
				),
			}),
		),
	});
	db.prepare("UPDATE selection_specs SET body = ?, spec_digest = ?").run(
		JSON.stringify(
			Object.fromEntries(Object.entries(normalizedSelection).reverse()),
		),
		normalizedSelection.specDigest,
	);
	reopen();
	expect(store.getObjectiveProfile("objective-clotho", 1)).toEqual(profile());
	expect(store.activeObjectiveProfiles(ref.agentId, ref.scopeId)).toEqual(
		ref.objectiveProfileRefs,
	);
	expect(store.assessmentSet(ref.roundId).assessments[0]).toEqual(
		originalAssessment,
	);
	expect(store.getResolution(ref.roundId)).toEqual(originalResolution);
	expect(store.getSelectionSpec(ref.roundId)).toEqual(normalizedSelection);
	expect(store.getIntention(initial.intentionId)).toEqual(initial);
	expect(store.listIntentions(ref.agentId, ref.scopeId, "proposed")).toEqual([
		intention(),
		initial,
	]);
	const adopted = store.transitionIntention(
		initial.intentionId,
		transition("adopted"),
		0,
	);
	reopen();
	expect(store.getIntention(initial.intentionId)).toEqual(adopted);
	expect(store.listIntentions(ref.agentId, ref.scopeId, "adopted")).toEqual([
		adopted,
	]);
	expect(store.getObjectiveProfile("missing", 1)).toBeNull();
	expect(store.getResolution("missing")).toBeNull();
	expect(store.getSelectionSpec("missing")).toBeNull();
	expect(store.getIntention("missing")).toBeNull();
	expect(store.listIntentions("missing", ref.scopeId)).toEqual([]);
});
