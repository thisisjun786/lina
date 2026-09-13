import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type Assessment,
	assessmentInputDigest,
	buildCandidateSet,
	buildCanonicalOption,
	type CanonicalOption,
	type IntentionRecord,
	type IntentionTransition,
	JUDGMENT_SCHEMA_VERSION,
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
	transitionIntention,
} from "../src/agents/index.ts";
import { Fixture } from "./fixture.ts";

let fixture: Fixture;
let path: string;
const stores = new Set<JudgmentStore>();
beforeEach(() => {
	fixture = new Fixture();
	path = join(fixture.dir, "judgment.sqlite");
});
afterEach(() => {
	for (const store of stores) store.close();
	stores.clear();
	fixture.close();
});
function open(file = path): JudgmentStore {
	const store = new JudgmentStore(file, { now: () => 1234 });
	stores.add(store);
	return store;
}
function close(store: JudgmentStore): void {
	store.close();
	stores.delete(store);
}
function database(file = path): DatabaseSync {
	return fixture.keep(new DatabaseSync(file));
}
function ddl(db: DatabaseSync) {
	return db
		.prepare(
			"SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		.all();
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
		intentionRevision: store.intentionRevision("agent-1", "scope-1"),
		objectiveProfileRefs: refs,
		observationRef: null,
		frozenNeuralRef: null,
		situation: "user_request",
		clockId: "clock-1",
		sequence,
		bindingGeneration: 0,
	});
}
const fixtureOptions = ["a", "b", "excluded"]
	.map((reason) =>
		buildCanonicalOption({
			kind: "noop",
			actor: { agentId: "agent-1", scopeId: "scope-1" },
			targetId: null,
			args: {},
			preconditions: { kind: "noop", reason },
		}),
	)
	.sort((a, b) => (a.optionKey < b.optionKey ? -1 : 1));
const [optionA, optionB, optionExcluded] = fixtureOptions;
if (!optionA || !optionB || !optionExcluded)
	throw Error("missing fixture options");
const A = optionA.optionKey,
	B = optionB.optionKey,
	EXCLUDED = optionExcluded.optionKey;
function closeCandidates(
	store: JudgmentStore,
	ref: JudgmentSnapshotRef,
	options: CanonicalOption[] = fixtureOptions.slice(0, 1),
) {
	store.closeCandidateSet(
		buildCandidateSet({
			roundId: ref.roundId,
			snapshotDigest: snapshotDigest(ref),
			options,
			eligibility: options.map((o) => ({
				optionKey: o.optionKey,
				eligible: o.optionKey !== EXCLUDED,
				reason: o.optionKey === EXCLUDED ? "not eligible" : null,
			})),
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
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	return value;
}

for (const stage of [
	"infeasible",
	"commitment_protection",
	"host_eligibility",
] as const) {
	test(`3996172412: recomputed forged ${stage} exclusion is rejected by the existing store API`, () => {
		const store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref, [optionA, optionB]);
		for (const module of MODULE_KINDS) {
			const original = assessment(ref, module);
			store.putAssessment(
				parseAssessment({
					...original,
					objectiveAssessments: [A, B].map((optionKey) => ({
						...original.objectiveAssessments[0],
						optionKey,
						stance: "accept",
					})),
				}),
			);
		}
		const record = parseResolutionRecord({
			...resolution(ref),
			excluded: [
				{
					optionKey: B,
					stage,
					byModule:
						stage === "infeasible"
							? "clotho"
							: stage === "commitment_protection"
								? "atropos"
								: null,
					reason: "forged exclusion",
				},
			],
		});
		const selection = rehashSelection({
			...spec(ref, record),
			assessmentSetDigest: judgmentDigest(store.assessmentSet(ref.roundId)),
			candidates: [
				{ optionKey: A, p0: 1, b: null },
				{ optionKey: B, p0: 0, b: null },
			],
		});
		expect(() =>
			store.recordResolution(ref.roundId, record, selection),
		).toThrow();
		expect(store.getRound(ref.roundId)?.status).toBe("open");
		expect(store.getResolution(ref.roundId)).toBeNull();
	});
}

test("canonical JSON bytes are shared with judgment digests", () => {
	const value = {
		z: [
			{ d: 1, c: 2 },
			{ b: null, a: "\u65e5\u672c\u8a9e" },
		],
		a: null,
		missing: undefined,
		text: "caf\u00e9",
	};
	expect(judgmentDigest(value)).toBe(
		createHash("sha256")
			.update(JSON.stringify(canonical(value)))
			.digest("hex"),
	);
	const store = open();
	const saved = profile();
	store.putObjectiveProfile(saved);
	const db = fixture.keep(new DatabaseSync(path, { readOnly: true }));
	expect(db.prepare("SELECT body FROM objective_profiles").get()).toEqual({
		body: JSON.stringify(canonical(saved)),
	});
});

test("fresh schema has exactly ten STRICT tables, metadata, WAL and unchanged DDL on reopen", () => {
	let store = open();
	const db = database();
	const original = ddl(db);
	expect(JUDGMENT_SCHEMA_VERSION).toBe(1);
	expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
	expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
		journal_mode: "wal",
	});
	expect(original.map(({ name }) => name)).toEqual([
		"assessments",
		"candidate_sets",
		"intention_records",
		"intention_transitions",
		"judgment_meta",
		"objective_profile_active",
		"objective_profiles",
		"resolution_records",
		"rounds",
		"selection_specs",
	]);
	for (const { sql } of original) expect(sql).toContain("STRICT");
	expect(
		db.prepare("SELECT key,value FROM judgment_meta ORDER BY key").all(),
	).toEqual([
		{ key: "schema_version", value: "1" },
		{ key: "store", value: "judgment" },
	]);
	close(store);
	store = open();
	expect(ddl(db)).toEqual(original);
	expect(store.getRound("missing")).toBeNull();
});

for (const change of [
	"CREATE TABLE foreign_table (id INTEGER)",
	"PRAGMA user_version = 99",
	"CREATE TABLE judgment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; INSERT INTO judgment_meta VALUES ('store','judgment'),('schema_version','1'); PRAGMA user_version=1",
])
	test(`foreign schema rejected: ${change}`, () => {
		const db = database();
		db.exec(change);
		const before = ddl(db);
		expect(() => open()).toThrow("unknown judgment store schema");
		expect(ddl(db)).toEqual(before);
	});

for (const change of [
	"ALTER TABLE rounds ADD COLUMN extra TEXT",
	"DROP TABLE candidate_sets",
	"UPDATE judgment_meta SET value='other' WHERE key='store'",
	"UPDATE judgment_meta SET value='2' WHERE key='schema_version'",
	"DELETE FROM judgment_meta WHERE key='store'",
	"CREATE INDEX extra ON rounds(status)",
	"PRAGMA user_version=2",
])
	test(`tampered judgment schema rejected: ${change}`, () => {
		close(open());
		const db = database();
		db.exec(change);
		expect(() => open()).toThrow("unknown judgment store schema");
	});

test("nonfresh empty SQLite schema is rejected", () => {
	const db = database();
	db.exec("VACUUM");
	expect(statSync(path).size).toBeGreaterThan(0);
	expect(() => open()).toThrow("unknown judgment store schema");
});

test("objective revisions are append-only and activation changes only for a new reference", () => {
	const store = open();
	const ref = store.putObjectiveProfile(profile());
	expect(store.putObjectiveProfile(profile())).toEqual(ref);
	expect(store.getObjectiveProfile(ref.objectiveId, 1)).toEqual(profile());
	expect(store.getObjectiveProfile("missing", 1)).toBeNull();
	expect(() =>
		store.putObjectiveProfile({ ...profile(), objective: "different" }),
	).toThrow("objective profile revision already exists");
	expect(store.activeObjectiveProfiles("agent-1", "scope-1")).toBeNull();
	expect(store.activateObjectiveProfile("agent-1", "scope-1", ref)).toEqual({
		activationRevision: 1,
	});
	expect(store.activateObjectiveProfile("agent-1", "scope-1", ref)).toEqual({
		activationRevision: 1,
	});
	const next = store.putObjectiveProfile(profile("clotho", 2));
	expect(store.activateObjectiveProfile("agent-1", "scope-1", next)).toEqual({
		activationRevision: 2,
	});
	expect(store.getObjectiveProfile(ref.objectiveId, 1)).toEqual(profile());
	for (const module of ["lachesis", "atropos"] as const)
		store.activateObjectiveProfile(
			"agent-1",
			"scope-1",
			store.putObjectiveProfile(profile(module)),
		);
	expect(store.activeObjectiveProfiles("agent-1", "scope-1")?.clotho).toEqual(
		next,
	);
	expect(store.activeObjectiveProfiles("agent-1", "other")).toBeNull();
	for (const invalid of [
		{ ...ref, digest: "wrong" },
		{ ...ref, revision: 99 },
		{ ...ref, extra: true },
	])
		expect(() =>
			store.activateObjectiveProfile("agent-1", "scope-1", invalid),
		).toThrow();
	expect(store.activeObjectiveProfiles("agent-1", "scope-1")?.clotho).toEqual(
		next,
	);
});

test("rounds freeze active references and reject duplicate ids or scope sequences", () => {
	const store = open();
	const ref = snapshot(store);
	const stale = {
		...ref,
		objectiveProfileRefs: {
			...ref.objectiveProfileRefs,
			clotho: { ...ref.objectiveProfileRefs.clotho, digest: "stale" },
		},
	};
	expect(() => store.openRound(stale)).toThrow("stale objective profile refs");
	expect(store.openRound(ref)).toEqual({
		roundId: ref.roundId,
		snapshotDigest: snapshotDigest(ref),
	});
	expect(() => store.openRound(ref)).toThrow();
	expect(() => store.openRound({ ...ref, roundId: "round-2" })).toThrow();
	store.activateObjectiveProfile(
		ref.agentId,
		ref.scopeId,
		store.putObjectiveProfile(profile("clotho", 2)),
	);
	expect(store.getRound(ref.roundId)).toEqual({
		snapshot: ref,
		status: "open",
		snapshotDigest: snapshotDigest(ref),
	});
	expect(() =>
		store.openRound({ ...ref, roundId: "round-3", sequence: 3 }),
	).toThrow("stale objective profile refs");
});

for (const tamper of ["snapshot", "snapshot_digest"] as const) {
	test(`3995117504: ${tamper} tampering is rejected on read and writes after reopen`, () => {
		let store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref);
		close(store);
		const db = database();
		db.prepare(`UPDATE rounds SET ${tamper} = ? WHERE round_id = ?`).run(
			tamper === "snapshot"
				? JSON.stringify({ ...ref, clockId: "tampered-clock" })
				: "tampered-digest",
			ref.roundId,
		);
		store = open();
		expect(() => store.getRound(ref.roundId)).toThrow(
			"snapshot digest mismatch",
		);
		expect(() => store.putAssessment(assessment(ref, "clotho"))).toThrow(
			"snapshot digest mismatch",
		);
		expect(() =>
			store.recordResolution(ref.roundId, resolution(ref, "held"), null),
		).toThrow("snapshot digest mismatch");
		expect(db.prepare("SELECT count(*) AS n FROM assessments").get()).toEqual({
			n: 0,
		});
		expect(() => store.getResolution(ref.roundId)).toThrow(
			"snapshot digest mismatch",
		);
		expect(
			db.prepare("SELECT count(*) AS n FROM resolution_records").get(),
		).toEqual({ n: 0 });
	});
}

test("3995117504: snapshot digest is checked after parser normalization", () => {
	const store = open();
	const ref = snapshot(store);
	ref.sourceRefs = [
		{ kind: "request", id: "a", revision: 1 },
		{ kind: "request", id: "b", revision: 1 },
	];
	store.openRound(ref);
	closeCandidates(store, ref);
	database()
		.prepare("UPDATE rounds SET snapshot = ? WHERE round_id = ?")
		.run(
			JSON.stringify({ ...ref, sourceRefs: [...ref.sourceRefs].reverse() }),
			ref.roundId,
		);
	expect(store.getRound(ref.roundId)).toEqual({
		snapshot: ref,
		status: "open",
		snapshotDigest: snapshotDigest(ref),
	});
});

test("assessments require an open matching snapshot and exactly one of each module", () => {
	const store = open();
	const ref = snapshot(store);
	expect(() => store.putAssessment(assessment(ref, "clotho"))).toThrow();
	store.openRound(ref);
	expect(() => store.putAssessment(assessment(ref, "clotho", "wrong"))).toThrow(
		"assessment snapshot mismatch",
	);
	store.putAssessment(assessment(ref, "clotho"));
	expect(() => store.putAssessment(assessment(ref, "clotho"))).toThrow(
		"duplicate assessment",
	);
	store.putAssessment(assessment(ref, "lachesis"));
	expect(() => store.assessmentSet(ref.roundId)).toThrow(
		"incomplete assessment set",
	);
	store.putAssessment(assessment(ref, "atropos"));
	const set = store.assessmentSet(ref.roundId);
	expect(set).toEqual(
		parseAssessmentSet({
			schemaVersion: 1,
			roundId: ref.roundId,
			snapshotDigest: snapshotDigest(ref),
			assessments: MODULE_KINDS.map((m) => assessment(ref, m)),
		}),
	);
	store.recordResolution(ref.roundId, resolution(ref, "held"), null);
	expect(() => store.putAssessment(assessment(ref, "clotho"))).toThrow();
	expect(store.assessmentSet(ref.roundId)).toEqual(set);
	expect(() => store.assessmentSet("missing")).toThrow(
		"incomplete assessment set",
	);
});

for (const change of [
	{ objectiveId: "unregistered-objective" },
	{ revision: 999 },
	{ digest: "wrong-objective-digest" },
]) {
	test(`assessment must match frozen objective ${Object.keys(change)[0]}`, () => {
		const store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref);
		const original = assessment(ref, "clotho");
		const changed = {
			...original,
			objectiveRef: { ...original.objectiveRef, ...change },
		};
		const invalid = parseAssessment({
			...changed,
			inputDigest: assessmentInputDigest(changed),
		});
		expect(() => store.putAssessment(invalid)).toThrow(
			"assessment objective mismatch",
		);
		expect(
			database().prepare("SELECT count(*) AS n FROM assessments").get(),
		).toEqual({ n: 0 });
		store.putAssessment(original);
	});
}

for (const status of ["resolved", "held", "deferred"] as const) {
	for (const change of [
		{ situation: "autonomous" as const },
		{ policyId: "other-policy" },
		{ policyRevision: 999 },
	]) {
		test(`${status} resolution must match snapshot ${Object.keys(change)[0]}`, () => {
			const store = open();
			const ref = snapshot(store);
			store.openRound(ref);
			closeCandidates(store, ref);
			for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
			const record = { ...resolution(ref, status), ...change };
			expect(() =>
				store.recordResolution(
					ref.roundId,
					record,
					status === "resolved" ? spec(ref, record) : null,
				),
			).toThrow("resolution snapshot mismatch");
			expect(store.getRound(ref.roundId)?.status).toBe("open");
			expect(store.getResolution(ref.roundId)).toBeNull();
			expect(store.getSelectionSpec(ref.roundId)).toBeNull();
		});
	}
}

test("resolved round requires all three persisted assessments", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	store.putAssessment(assessment(ref, "clotho"));
	expect(() =>
		store.recordResolution(ref.roundId, resolution(ref), spec(ref)),
	).toThrow("incomplete assessment set");
	expect(store.getRound(ref.roundId)?.status).toBe("open");
	expect(store.getResolution(ref.roundId)).toBeNull();
	expect(store.getSelectionSpec(ref.roundId)).toBeNull();
});

const selectionMismatches: Array<{
	label: string;
	change: (selection: SelectionSpec) => Partial<SelectionSpec>;
	error: string;
}> = [
	{
		label: "assessment set digest",
		change: () => ({ assessmentSetDigest: "nonexistent-set" }),
		error: "selection assessment set mismatch",
	},
	{
		label: "resolution digest",
		change: () => ({ resolutionDigest: "wrong-resolution" }),
		error: "selection resolution digest mismatch",
	},
	{
		label: "policy id",
		change: () => ({ policyId: "other-policy" }),
		error: "selection policy mismatch",
	},
	{
		label: "policy revision",
		change: () => ({ policyRevision: 999 }),
		error: "selection policy mismatch",
	},
	{
		label: "situation",
		change: () => ({ situation: "autonomous" }),
		error: "selection policy mismatch",
	},
	...[
		{ objectiveId: "other-objective" },
		{ revision: 999 },
		{ digest: "wrong-objective" },
	].map((change) => ({
		label: `objective ${Object.keys(change)[0]}`,
		change: (selection: SelectionSpec) => ({
			objectiveProfileRefs: {
				...selection.objectiveProfileRefs,
				clotho: { ...selection.objectiveProfileRefs.clotho, ...change },
			},
		}),
		error: "selection objective refs mismatch",
	})),
];
for (const { label, change, error } of selectionMismatches) {
	test(`selection rejects inconsistent ${label} atomically`, () => {
		const store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref);
		for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
		const selection = spec(ref);
		const changed = { ...selection, ...change(selection) };
		const invalid = parseSelectionSpec({
			...changed,
			specDigest: judgmentDigest({ ...changed, specDigest: undefined }),
		});
		expect(() =>
			store.recordResolution(ref.roundId, resolution(ref), invalid),
		).toThrow(error);
		expect(store.getRound(ref.roundId)?.status).toBe("open");
		expect(store.getResolution(ref.roundId)).toBeNull();
		expect(store.getSelectionSpec(ref.roundId)).toBeNull();
		store.recordResolution(ref.roundId, resolution(ref), selection);
		expect(store.getRound(ref.roundId)?.status).toBe("resolved");
		expect(store.getResolution(ref.roundId)).toEqual(resolution(ref));
		expect(store.getSelectionSpec(ref.roundId)).toEqual(selection);
	});
}

test("3998853057 assessments retain frozen refs but stale objective resolution rejects atomically", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	const next = store.putObjectiveProfile(profile("clotho", 2));
	store.activateObjectiveProfile(ref.agentId, ref.scopeId, next);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const selection = spec(ref);
	expect(selection.assessmentSetDigest).toBe(
		judgmentDigest(store.assessmentSet(ref.roundId)),
	);
	expect(() =>
		store.recordResolution(ref.roundId, resolution(ref), selection),
	).toThrow("stale objective profile refs");
	expect(store.assessmentSet(ref.roundId).assessments).toHaveLength(3);
	expect(store.getResolution(ref.roundId)).toBeNull();
	expect(store.getSelectionSpec(ref.roundId)).toBeNull();
	expect(store.getRound(ref.roundId)?.status).toBe("open");
});

test("3998853057 resolved action remains historical after activation and intention changes", () => {
	let store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	store.activateObjectiveProfile(
		ref.agentId,
		ref.scopeId,
		ref.objectiveProfileRefs.clotho,
	);
	store.activateObjectiveProfile(
		"other-agent",
		ref.scopeId,
		store.putObjectiveProfile(profile("clotho", 2)),
	);
	store.activateObjectiveProfile(
		ref.agentId,
		"other-scope",
		store.putObjectiveProfile(profile("clotho", 2)),
	);
	store.recordResolution(ref.roundId, resolution(ref), spec(ref));
	store.activateObjectiveProfile(
		ref.agentId,
		ref.scopeId,
		store.putObjectiveProfile(profile("clotho", 2)),
	);
	store.putIntention(intention());
	store.transitionIntention("intention-1", transition("adopted"), 0);
	close(store);
	store = open();
	expect(store.getResolution(ref.roundId)).toEqual(resolution(ref));
	expect(store.getSelectionSpec(ref.roundId)).toEqual(spec(ref));
});

test("3998853070 scoped mutation sum counts creates/transitions and survives reopen", () => {
	let store = open();
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(0);
	store.putIntention(intention());
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(1);
	store.putIntention(intention("second"));
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(2);
	store.transitionIntention("intention-1", transition("adopted"), 0);
	expect(() => store.putIntention(intention())).toThrow("duplicate intention");
	expect(() =>
		store.transitionIntention("intention-1", transition("active"), 0),
	).toThrow("stale intention revision");
	expect(() =>
		store.transitionIntention("intention-1", transition("completed"), 1),
	).toThrow();
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(3);
	expect(store.intentionRevision("agent-1", "other")).toBe(0);
	expect(store.intentionRevision("other", "scope-1")).toBe(0);
	close(store);
	store = open();
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(3);
});

for (const mutation of ["create", "transition"] as const) {
	test(`3998853070 ${mutation} invalidates open and resolution even without candidate intention refs`, () => {
		const store = open();
		store.putIntention(intention());
		const ref = { ...snapshot(store), intentionRevision: 1 };
		store.openRound(ref);
		closeCandidates(store, ref);
		for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
		if (mutation === "create") store.putIntention(intention("second"));
		else store.transitionIntention("intention-1", transition("adopted"), 0);
		expect(() =>
			store.openRound({ ...ref, roundId: "stale", sequence: 2 }),
		).toThrow("stale intention revision");
		expect(() =>
			store.recordResolution(ref.roundId, resolution(ref), spec(ref)),
		).toThrow("stale intention revision");
		expect(store.getRound(ref.roundId)?.status).toBe("open");
		expect(store.getResolution(ref.roundId)).toBeNull();
		expect(store.getSelectionSpec(ref.roundId)).toBeNull();
		const fresh = {
			...ref,
			roundId: "fresh",
			sequence: 3,
			intentionRevision: store.intentionRevision(ref.agentId, ref.scopeId),
		};
		store.openRound(fresh);
		closeCandidates(store, fresh);
		for (const m of MODULE_KINDS) store.putAssessment(assessment(fresh, m));
		store.recordResolution(fresh.roundId, resolution(fresh), spec(fresh));
		expect(store.getRound(fresh.roundId)?.status).toBe("resolved");
	});
}

test("3998853070 unsafe scoped counter prevents both mutation paths atomically", () => {
	const store = open();
	store.putIntention(intention());
	// The owner counter boundary is the only synthetic value; all mutations use real SQLite.
	const counter = spyOn(store, "intentionRevision").mockReturnValue(
		Number.MAX_SAFE_INTEGER,
	);
	try {
		expect(() => store.putIntention(intention("overflow"))).toThrow(
			"invalid judgment revision",
		);
		expect(() =>
			store.transitionIntention("intention-1", transition("adopted"), 0),
		).toThrow("invalid judgment revision");
		expect(store.getIntention("overflow")).toBeNull();
		expect(store.getIntention("intention-1")).toEqual(intention());
		expect(
			database()
				.prepare("SELECT count(*) AS n FROM intention_transitions")
				.get(),
		).toEqual({ n: 0 });
	} finally {
		counter.mockRestore();
	}
	expect(store.intentionRevision("agent-1", "scope-1")).toBe(1);
});

test("3998853089 scoped sequence increases across handles and reopen with gaps allowed", () => {
	let store = open();
	const ref = snapshot(store, "two", 2);
	const second = open();
	store.openRound(ref);
	for (const sequence of [1, 2])
		expect(() =>
			second.openRound({ ...ref, roundId: `rejected-${sequence}`, sequence }),
		).toThrow();
	second.openRound({ ...ref, roundId: "four", sequence: 4 });
	close(store);
	store = open();
	expect(() =>
		store.openRound({ ...ref, roundId: "three", sequence: 3 }),
	).toThrow("stale round sequence");
	store.openRound({ ...ref, roundId: "five", sequence: 5 });
	for (const change of [{ agentId: "other" }, { scopeId: "other" }]) {
		const independent = {
			...ref,
			...change,
			roundId: JSON.stringify(change),
			sequence: 1,
		};
		for (const m of MODULE_KINDS)
			store.activateObjectiveProfile(
				independent.agentId,
				independent.scopeId,
				ref.objectiveProfileRefs[m],
			);
		store.openRound(independent);
	}
	expect(database().prepare("SELECT count(*) AS n FROM rounds").get()).toEqual({
		n: 5,
	});
});

for (const field of ["acceptedAt", "deadline", "at"] as const) {
	test(`3995355457 store rejects noncanonical ${field} before mutation`, () => {
		const store = open();
		const value = "2026-02-30T00:00:00.000Z";
		if (field === "at") {
			store.putIntention(intention());
			expect(() =>
				store.transitionIntention(
					"intention-1",
					{ ...transition("adopted"), at: value },
					0,
				),
			).toThrow();
			expect(store.getIntention("intention-1")).toEqual(intention());
		} else {
			const record = intention();
			if (field === "deadline") record.deadline = value;
			else record.acceptance.acceptedAt = value;
			expect(() => store.putIntention(record)).toThrow();
			expect(store.getIntention(record.intentionId)).toBeNull();
		}
		expect(
			database()
				.prepare("SELECT count(*) AS n FROM intention_transitions")
				.get(),
		).toEqual({ n: 0 });
	});
}

test("resolution and selection persist atomically and survive reopen with canonical JSON", () => {
	let store = open();
	store.putIntention(intention());
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const record = resolution(ref);
	const selection = spec(ref);
	store.recordResolution(ref.roundId, record, selection);
	expect(store.getRound(ref.roundId)?.status).toBe("resolved");
	expect(() =>
		store.recordResolution(ref.roundId, record, selection),
	).toThrow();
	close(store);
	store = open();
	expect(store.getResolution(ref.roundId)).toEqual(record);
	const saved = store.getSelectionSpec(ref.roundId);
	expect(saved).toEqual(selection);
	if (!saved) throw Error("missing selection");
	expect(saved.specDigest).toBe(
		judgmentDigest({ ...saved, specDigest: undefined }),
	);
	expect(store.getIntention("intention-1")).toEqual(intention());
	const db = database();
	for (const [table, column] of [
		["objective_profiles", "body"],
		["rounds", "snapshot"],
		["assessments", "body"],
		["candidate_sets", "body"],
		["resolution_records", "body"],
		["selection_specs", "body"],
		["intention_records", "body"],
	] as const) {
		for (const { body: json } of db
			.prepare(`SELECT ${column} AS body FROM ${table}`)
			.all()) {
			const body = String(json);
			expect(body).toBe(JSON.stringify(canonical(JSON.parse(body))));
		}
	}
	expect(db.prepare("SELECT created_at FROM rounds").get()).toEqual({
		created_at: 1234,
	});
});

test("resolution rejects mismatched selection presence, round id and snapshot without partial rows", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	const other = { ...ref, roundId: "other" };
	const db = database();
	for (const [record, selection] of [
		[resolution(ref, "deferred"), spec(ref)],
		[resolution(ref, "held"), spec(ref)],
		[resolution(ref), null],
		[resolution(ref), spec(other)],
		[resolution(ref), spec({ ...ref, workingRevision: 99 })],
	] as const) {
		expect(() =>
			store.recordResolution(ref.roundId, record, selection),
		).toThrow("selection spec mismatch");
		expect(store.getRound(ref.roundId)?.status).toBe("open");
		expect(
			db.prepare("SELECT count(*) AS n FROM resolution_records").get(),
		).toEqual({ n: 0 });
		expect(
			db.prepare("SELECT count(*) AS n FROM selection_specs").get(),
		).toEqual({ n: 0 });
	}
	expect(() =>
		store.recordResolution(ref.roundId, resolution(other), spec(ref)),
	).toThrow();
	store.recordResolution(ref.roundId, resolution(ref, "held"), null);
	expect(store.getRound(ref.roundId)?.status).toBe("held");
	expect(store.getSelectionSpec(ref.roundId)).toBeNull();
	expect(store.getResolution("missing")).toBeNull();
});

test("SQLite failure during resolution rolls back the already inserted resolution", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const db = database();
	db.exec(
		"CREATE TRIGGER fail_spec BEFORE INSERT ON selection_specs BEGIN SELECT RAISE(ABORT, 'fixture spec failure'); END",
	);
	expect(() =>
		store.recordResolution(ref.roundId, resolution(ref), spec(ref)),
	).toThrow("fixture spec failure");
	expect(store.getResolution(ref.roundId)).toBeNull();
	expect(store.getRound(ref.roundId)?.status).toBe("open");
	db.exec("DROP TRIGGER fail_spec");
	store.recordResolution(ref.roundId, resolution(ref), spec(ref));
});

test("intention transitions match the pure function, persist, filter and reject stale/invalid changes atomically", () => {
	let store = open();
	const initial = intention();
	store.putIntention(initial);
	expect(() => store.putIntention(initial)).toThrow("duplicate intention");
	const adopted = transitionIntention(initial, transition("adopted"));
	expect(() =>
		store.putIntention({ ...adopted, intentionId: "invalid-new" }),
	).toThrow();
	expect(
		store.transitionIntention(initial.intentionId, transition("adopted"), 0),
	).toEqual(adopted);
	const active = transitionIntention(adopted, transition("active"));
	expect(
		store.transitionIntention(initial.intentionId, transition("active"), 1),
	).toEqual(active);
	expect(active.revision).toBe(2);
	const db = database();
	const rows = () =>
		db.prepare("SELECT * FROM intention_transitions ORDER BY revision").all();
	expect(rows()).toEqual(
		active.history.map((t, i) => ({
			intention_id: initial.intentionId,
			revision: i + 1,
			from_status: t.from,
			to_status: t.to,
			reason: t.reason,
			evidence_ref: t.evidenceRef,
			at: t.at,
		})),
	);
	expect(() =>
		store.transitionIntention(initial.intentionId, transition("suspended"), 1),
	).toThrow("stale intention revision");
	expect(() =>
		store.transitionIntention(initial.intentionId, transition("proposed"), 2),
	).toThrow("invalid intention transition: active -> proposed");
	expect(store.getIntention(initial.intentionId)).toEqual(active);
	expect(rows()).toHaveLength(2);
	store.putIntention(intention("aaa"));
	store.putIntention({ ...intention("elsewhere"), scopeId: "other" });
	expect(
		store.listIntentions("agent-1", "scope-1").map((r) => r.intentionId),
	).toEqual(["aaa", "intention-1"]);
	expect(store.listIntentions("agent-1", "scope-1", "active")).toEqual([
		active,
	]);
	close(store);
	store = open();
	expect(store.getIntention(initial.intentionId)).toEqual(active);
	expect(store.getIntention("missing")).toBeNull();
});

test("SQLite transition insert failure rolls back updated intention", () => {
	const store = open();
	store.putIntention(intention());
	const db = database();
	db.exec(
		"CREATE TRIGGER fail_transition BEFORE INSERT ON intention_transitions BEGIN SELECT RAISE(ABORT, 'fixture transition failure'); END",
	);
	expect(() =>
		store.transitionIntention("intention-1", transition("adopted"), 0),
	).toThrow("fixture transition failure");
	expect(store.getIntention("intention-1")).toEqual(intention());
	expect(
		db.prepare("SELECT count(*) AS n FROM intention_transitions").get(),
	).toEqual({ n: 0 });
	db.exec("DROP TRIGGER fail_transition");
	expect(
		store.transitionIntention("intention-1", transition("adopted"), 0).revision,
	).toBe(1);
});

test("external records are reparsed and malformed persisted bodies are rejected on read", () => {
	const store = open();
	store.putIntention(intention());
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const action of [
		() =>
			store.putObjectiveProfile({
				...profile(),
				extra: true,
			} as ObjectiveProfile),
		() =>
			store.openRound({
				...ref,
				schemaVersion: 2,
			} as unknown as JudgmentSnapshotRef),
		() =>
			store.putAssessment({
				...assessment(ref, "clotho"),
				inputDigest: "invalid",
			}),
		() =>
			store.recordResolution(
				ref.roundId,
				{ ...resolution(ref), extra: true } as ResolutionRecord,
				spec(ref),
			),
		() =>
			store.recordResolution(ref.roundId, resolution(ref), {
				...spec(ref),
				specDigest: "invalid",
			}),
		() =>
			store.putIntention({ ...intention(), extra: true } as IntentionRecord),
	])
		expect(action).toThrow();
	const db = database();
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	store.recordResolution(ref.roundId, resolution(ref), spec(ref));
	for (const [table, column, read] of [
		[
			"objective_profiles",
			"body",
			() => store.getObjectiveProfile("objective-clotho", 1),
		],
		["rounds", "snapshot", () => store.getRound(ref.roundId)],
		["resolution_records", "body", () => store.getResolution(ref.roundId)],
		["selection_specs", "body", () => store.getSelectionSpec(ref.roundId)],
		["intention_records", "body", () => store.getIntention("intention-1")],
	] as const) {
		db.prepare(`UPDATE ${table} SET ${column} = ?`).run('{"schemaVersion":2}');
		expect(read).toThrow(/Unsupported .* schema version/);
	}
	expect(parseObjectiveProfile(profile())).toEqual(profile());
});

test("every public method rejects use after close", () => {
	const store = open();
	const ref = snapshot(store);
	close(store);
	for (const action of [
		() => store.close(),
		() => store.putObjectiveProfile(profile()),
		() => store.getObjectiveProfile("objective-clotho", 1),
		() =>
			store.activateObjectiveProfile(
				"agent-1",
				"scope-1",
				ref.objectiveProfileRefs.clotho,
			),
		() => store.activeObjectiveProfiles("agent-1", "scope-1"),
		() => store.openRound(ref),
		() => store.getRound(ref.roundId),
		() => store.candidateSet(ref.roundId),
		() => closeCandidates(store, ref),
		() => store.putAssessment(assessment(ref, "clotho")),
		() => store.assessmentSet(ref.roundId),
		() => store.recordResolution(ref.roundId, resolution(ref), spec(ref)),
		() => store.getResolution(ref.roundId),
		() => store.getSelectionSpec(ref.roundId),
		() => store.putIntention(intention()),
		() => store.getIntention("intention-1"),
		() => store.transitionIntention("intention-1", transition("adopted"), 0),
		() => store.listIntentions("agent-1", "scope-1"),
	])
		expect(action).toThrow(/closed/);
});

for (const reopen of [false, true]) {
	for (const [table, column, value] of [
		["intention_records", "intention_id", "hidden"],
		["intention_records", "agent_id", "hidden"],
		["intention_records", "scope_id", "hidden"],
		["intention_records", "status", "completed"],
		["intention_records", "revision", 99],
		["objective_profiles", "objective_id", "hidden"],
		["objective_profiles", "revision", 99],
		["objective_profiles", "module_kind", "lachesis"],
		["objective_profile_active", "module_kind", "hidden"],
		["rounds", "round_id", "hidden"],
		["rounds", "agent_id", "hidden"],
		["rounds", "scope_id", "hidden"],
		["rounds", "situation", "autonomous"],
		["rounds", "sequence", 99],
		["rounds", "status", "open"],
		["assessments", "round_id", "hidden"],
		["assessments", "module_kind", "hidden"],
		["resolution_records", "round_id", "hidden"],
		["selection_specs", "round_id", "hidden"],
	] as const) {
		test(`3995956579/3995958859: ${table}.${column} cannot hide a row (reopen=${reopen})`, () => {
			let store = open();
			const ref = snapshot(store);
			store.openRound(ref);
			closeCandidates(store, ref);
			for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
			store.recordResolution(ref.roundId, resolution(ref), spec(ref));
			store.putIntention(intention());
			expect(
				store.listIntentions("agent-1", "scope-1", "proposed"),
			).toHaveLength(1);
			const db = database();
			db.exec("PRAGMA foreign_keys = OFF");
			db.prepare(
				`UPDATE ${table} SET ${column} = ? WHERE rowid = (SELECT min(rowid) FROM ${table})`,
			).run(value);
			if (reopen) {
				close(store);
				store = open();
			}
			expect(() =>
				store.listIntentions("agent-1", "scope-1", "proposed"),
			).toThrow(/metadata mismatch/);
			expect(() => store.putIntention(intention("new"))).toThrow(
				/metadata mismatch/,
			);
			expect(
				db.prepare("SELECT count(*) AS n FROM intention_records").get(),
			).toEqual({ n: 1 });
		});
	}
	for (const sql of [
		"UPDATE intention_transitions SET intention_id = 'hidden'",
		"UPDATE intention_transitions SET revision = 99",
		"UPDATE intention_transitions SET from_status = 'active'",
		"UPDATE intention_transitions SET to_status = 'cancelled'",
		"UPDATE intention_transitions SET reason = 'changed'",
		"UPDATE intention_transitions SET evidence_ref = NULL",
		"UPDATE intention_transitions SET at = '2026-09-12T00:00:00.000Z'",
		"DELETE FROM intention_transitions",
		"INSERT INTO intention_transitions SELECT intention_id, 2, from_status, to_status, reason, evidence_ref, at FROM intention_transitions",
	]) {
		test(`3995958859: transition ledger agrees with history (reopen=${reopen}): ${sql}`, () => {
			let store = open();
			store.putIntention(intention());
			store.transitionIntention("intention-1", transition("adopted"), 0);
			database().exec(`PRAGMA foreign_keys = OFF; ${sql}`);
			if (reopen) {
				close(store);
				store = open();
			}
			expect(() => store.getIntention("intention-1")).toThrow(
				"intention transition metadata mismatch",
			);
			expect(() =>
				store.transitionIntention("intention-1", transition("active"), 1),
			).toThrow("intention transition metadata mismatch");
		});
	}
}

function rehashSelection(selection: SelectionSpec): SelectionSpec {
	return parseSelectionSpec({
		...selection,
		eligibleDigest: judgmentDigest(
			selection.candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
		),
		specDigest: judgmentDigest({
			...selection,
			specDigest: undefined,
			eligibleDigest: judgmentDigest(
				selection.candidates.filter((c) => c.p0 > 0).map((c) => c.optionKey),
			),
		}),
	});
}

test("3995958855: valid hashes cannot substitute a candidate", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const record = resolution(ref);
	const original = spec(ref);
	for (const candidates of [
		[{ optionKey: "zz-forged", p0: 1, b: null }],
		[
			{ optionKey: A, p0: 1, b: null },
			{ optionKey: "zz-forged", p0: 0, b: null },
		],
	]) {
		const forged = rehashSelection({ ...original, candidates });
		expect(() => store.recordResolution(ref.roundId, record, forged)).toThrow(
			"selection policy replay mismatch",
		);
		expect(store.getResolution(ref.roundId)).toBeNull();
		expect(store.getRound(ref.roundId)?.status).toBe("open");
	}
	const forgedRecord = parseResolutionRecord({
		...record,
		ranking: [{ optionKey: "zz-forged", rank: 1 }],
	});
	const forged = rehashSelection({
		...original,
		resolutionDigest: judgmentDigest(forgedRecord),
		candidates: [{ optionKey: "zz-forged", p0: 1, b: null }],
	});
	expect(() =>
		store.recordResolution(ref.roundId, forgedRecord, forged),
	).toThrow("resolution policy replay mismatch");
	store.recordResolution(ref.roundId, record, original);
});

test("3995958855: baseline uses declared ratio and retains unassessed host exclusions", () => {
	let store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref, [optionA, optionB, optionExcluded]);
	for (const m of MODULE_KINDS) {
		const original = assessment(ref, m);
		store.putAssessment(
			parseAssessment({
				...original,
				objectiveAssessments: [
					...original.objectiveAssessments,
					{
						...original.objectiveAssessments[0],
						optionKey: B,
						stance: "accept",
					},
				],
			}),
		);
	}
	const record = parseResolutionRecord({
		...resolution(ref),
		ranking: [
			{ optionKey: A, rank: 1 },
			{ optionKey: B, rank: 2 },
		],
		excluded: [
			{
				optionKey: EXCLUDED,
				stage: "host_eligibility",
				byModule: null,
				reason: "not eligible",
			},
		],
	});
	const candidates = [
		{ optionKey: A, p0: 2 / 3, b: null },
		{ optionKey: B, p0: 1 / 3, b: null },
		{ optionKey: EXCLUDED, p0: 0, b: null },
	];
	const selection = rehashSelection({
		...spec(ref, record),
		assessmentSetDigest: judgmentDigest(store.assessmentSet(ref.roundId)),
		candidates,
	});
	for (const altered of [
		{
			candidates: candidates.map((c) => ({
				...c,
				p0: c.optionKey === EXCLUDED ? 0 : 0.5,
			})),
		},
		{
			candidates: candidates.map((c) => ({
				...c,
				p0: c.optionKey === EXCLUDED ? 0.1 : 0.45,
			})),
		},
		{ candidates: candidates.filter((c) => c.optionKey !== EXCLUDED) },
		{ lambda: 1 },
	]) {
		const invalid = rehashSelection({ ...selection, ...altered });
		expect(() => store.recordResolution(ref.roundId, record, invalid)).toThrow(
			"selection policy replay mismatch",
		);
		expect(store.getResolution(ref.roundId)).toBeNull();
	}
	store.recordResolution(ref.roundId, record, selection);
	close(store);
	store = open();
	expect(store.getSelectionSpec(ref.roundId)).toEqual(selection);
	expect(store.assessmentSet(ref.roundId).assessments).toHaveLength(3);
});

test("3995956579: owner writes reuse validation; reopen and external commits invalidate it", () => {
	let store = open();
	const prepare = spyOn(DatabaseSync.prototype, "prepare");
	const scans = () =>
		prepare.mock.calls.filter(
			([sql]) => sql === "SELECT * FROM intention_records",
		).length;
	try {
		for (let i = 0; i < 12; i += 1) {
			const id = `intention-${i}`;
			store.putIntention(intention(id));
			store.transitionIntention(id, transition("adopted"), 0);
			expect(store.getIntention(id)?.status).toBe("adopted");
		}
		expect(scans()).toBe(1);
		close(store);
		store = open();
		expect(store.listIntentions("agent-1", "scope-1", "adopted")).toHaveLength(
			12,
		);
		expect(scans()).toBe(2);
		database().exec("UPDATE intention_records SET created_at = created_at + 1");
		expect(store.listIntentions("agent-1", "scope-1", "adopted")).toHaveLength(
			12,
		);
		expect(scans()).toBe(3);
		expect(store.getIntention("intention-0")?.revision).toBe(1);
		expect(scans()).toBe(3);
	} finally {
		prepare.mockRestore();
	}
});

test("3995956579: validation and filtered read share one SQLite snapshot", () => {
	const store = open();
	store.putIntention(intention());
	const db = database();
	const original = DatabaseSync.prototype.prepare;
	let changed = false;
	const prepare = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			if (!changed && sql.includes("FROM intention_records WHERE agent_id")) {
				changed = true;
				db.exec("UPDATE intention_records SET status = 'completed'");
			}
			return original.call(this, sql);
		},
	);
	try {
		expect(store.listIntentions("agent-1", "scope-1", "proposed")).toEqual([
			intention(),
		]);
		expect(changed).toBe(true);
		expect(() =>
			store.listIntentions("agent-1", "scope-1", "proposed"),
		).toThrow("intention metadata mismatch");
	} finally {
		prepare.mockRestore();
	}
});

test("3995958855: rehashed ranking must reflect persisted stances", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref, [optionA, optionB]);
	for (const module of MODULE_KINDS) {
		const original = assessment(ref, module);
		store.putAssessment(
			parseAssessment({
				...original,
				objectiveAssessments: [
					...original.objectiveAssessments,
					{
						...original.objectiveAssessments[0],
						optionKey: B,
						stance: "accept",
					},
				],
			}),
		);
	}
	for (const ranking of [
		[
			{ optionKey: B, rank: 1 },
			{ optionKey: A, rank: 2 },
		],
		[
			{ optionKey: A, rank: 1 },
			{ optionKey: B, rank: 1 },
		],
		[
			{ optionKey: A, rank: 2 },
			{ optionKey: B, rank: 3 },
		],
	]) {
		const record = parseResolutionRecord({ ...resolution(ref), ranking });
		const selection = rehashSelection({
			...spec(ref, record),
			assessmentSetDigest: judgmentDigest(store.assessmentSet(ref.roundId)),
			candidates: [
				{ optionKey: A, p0: 0.5, b: null },
				{ optionKey: B, p0: 0.5, b: null },
			],
		});
		expect(() =>
			store.recordResolution(ref.roundId, record, selection),
		).toThrow("resolution policy replay mismatch");
		expect(store.getRound(ref.roundId)?.status).toBe("open");
	}
});

test("3995958855: missing ranked assessments reject without inventing excluded coverage", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref, [optionA, optionB]);
	for (const module of MODULE_KINDS)
		store.putAssessment(assessment(ref, module));
	const record = parseResolutionRecord({
		...resolution(ref),
		ranking: [
			{ optionKey: A, rank: 1 },
			{ optionKey: B, rank: 2 },
		],
	});
	const selection = rehashSelection({
		...spec(ref, record),
		candidates: [
			{ optionKey: A, p0: 2 / 3, b: null },
			{ optionKey: B, p0: 1 / 3, b: null },
		],
	});
	expect(() => store.recordResolution(ref.roundId, record, selection)).toThrow(
		"resolution policy replay mismatch",
	);
	expect(store.getSelectionSpec(ref.roundId)).toBeNull();
});

for (const reopen of [false, true]) {
	test(`3995958855: persisted rehashed candidate remains bound to assessments (reopen=${reopen})`, () => {
		let store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref);
		for (const module of MODULE_KINDS)
			store.putAssessment(assessment(ref, module));
		const record = resolution(ref);
		const selection = spec(ref);
		store.recordResolution(ref.roundId, record, selection);
		const forged = rehashSelection({
			...selection,
			candidates: [{ optionKey: "zz-forged", p0: 1, b: null }],
		});
		database()
			.prepare("UPDATE selection_specs SET body = ?, spec_digest = ?")
			.run(JSON.stringify(forged), forged.specDigest);
		if (reopen) {
			close(store);
			store = open();
		}
		expect(() => store.getSelectionSpec(ref.roundId)).toThrow(
			"selection policy replay mismatch",
		);
	});
}

test("3995958855: no baseline is guessed for undeclared policy revisions", () => {
	const store = open();
	const ref = { ...snapshot(store), policyRevision: 2 };
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const module of MODULE_KINDS)
		store.putAssessment(assessment(ref, module));
	const record = parseResolutionRecord({
		...resolution(ref),
		policyRevision: 2,
	});
	const selection = rehashSelection({
		...spec(ref, record),
		policyRevision: 2,
	});
	expect(() => store.recordResolution(ref.roundId, record, selection)).toThrow(
		"policy snapshot mismatch",
	);
	expect(() =>
		store.recordResolution(
			ref.roundId,
			{ ...record, status: "held", holdReason: "no policy declaration" },
			null,
		),
	).toThrow("policy snapshot mismatch");
	expect(store.getRound(ref.roundId)?.status).toBe("open");
	expect(store.getResolution(ref.roundId)).toBeNull();
});

test("missing parent is private; directory and database symlinks are rejected", () => {
	const parent = join(fixture.dir, "private");
	open(join(parent, "judgment.sqlite"));
	expect(statSync(parent).mode & 0o777).toBe(0o700);
	const target = join(fixture.dir, "target");
	mkdirSync(target);
	const link = join(fixture.dir, "link");
	symlinkSync(target, link);
	expect(() => open(join(link, "judgment.sqlite"))).toThrow(/unsafe directory/);
	const file = join(target, "judgment.sqlite");
	writeFileSync(file, "");
	symlinkSync(file, path);
	expect(() => open()).toThrow(/unsafe regular file/);
});

test("ledger audit rejects a resolved round whose selection was deleted", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	for (const module of MODULE_KINDS)
		store.putAssessment(assessment(ref, module));
	store.recordResolution(ref.roundId, resolution(ref), spec(ref));
	database().exec("DELETE FROM selection_specs");
	expect(() => store.getSelectionSpec(ref.roundId)).toThrow(
		"selection spec metadata mismatch",
	);
});

test("ledger audit rejects orphaned assessments before unrelated reads", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	store.putAssessment(assessment(ref, "clotho"));
	const db = database();
	db.exec("PRAGMA foreign_keys = OFF; DELETE FROM rounds");
	expect(() => store.getIntention("missing")).toThrow(
		"judgment foreign key mismatch",
	);
});

for (const change of [
	{ policyId: "other-policy" },
	{ policyRevision: 2 },
	{ situation: "autonomous" as const },
]) {
	test(`ledger audit binds rehashed resolution ${Object.keys(change)[0]} to its snapshot`, () => {
		const store = open();
		const ref = snapshot(store);
		store.openRound(ref);
		closeCandidates(store, ref);
		store.recordResolution(ref.roundId, resolution(ref, "held"), null);
		const changed = { ...resolution(ref, "held"), ...change };
		database()
			.prepare("UPDATE resolution_records SET body = ?, digest = ?")
			.run(JSON.stringify(changed), judgmentDigest(changed));
		expect(() => store.getResolution(ref.roundId)).toThrow(
			"resolution snapshot mismatch",
		);
	});
}

test("ledger audit retains the historical objective referenced by a round", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	const next = store.putObjectiveProfile(profile("clotho", 2));
	store.activateObjectiveProfile(ref.agentId, ref.scopeId, next);
	database().exec(
		"DELETE FROM objective_profiles WHERE module_kind = 'clotho' AND revision = 1",
	);
	expect(() => store.getRound(ref.roundId)).toThrow(
		"snapshot objective profile mismatch",
	);
});

test("ledger audit binds rehashed assessment evidence to its frozen snapshot", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	store.putAssessment(assessment(ref, "clotho"));
	const changed = assessment(ref, "clotho", "b".repeat(64));
	database()
		.prepare(
			"UPDATE assessments SET body = ?, digest = ?, snapshot_digest = ?, input_digest = ?",
		)
		.run(
			JSON.stringify(changed),
			judgmentDigest(changed),
			changed.snapshotDigest,
			changed.inputDigest,
		);
	expect(() => store.getRound(ref.roundId)).toThrow(
		"assessment snapshot mismatch",
	);
});

test("ledger audit binds rehashed assessment objectives to the frozen module", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	closeCandidates(store, ref);
	store.putAssessment(assessment(ref, "clotho"));
	const changed = {
		...assessment(ref, "clotho"),
		objectiveRef: ref.objectiveProfileRefs.atropos,
	};
	changed.inputDigest = assessmentInputDigest(changed);
	database()
		.prepare("UPDATE assessments SET body = ?, digest = ?, input_digest = ?")
		.run(JSON.stringify(changed), judgmentDigest(changed), changed.inputDigest);
	expect(() => store.getRound(ref.roundId)).toThrow(
		"assessment objective mismatch",
	);
});
