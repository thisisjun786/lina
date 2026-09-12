import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type Assessment,
	assessmentInputDigest,
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
		proposedOptionKeys: ["a"],
		objectiveAssessments: [
			{
				optionKey: "a",
				stance: "prefer",
				severity: null,
				unavailableReason: null,
				gain: "gain",
				loss: "loss",
				uncertainty: "unknown",
				evidenceRefs: [],
			},
		],
		recommendedOptionKeys: ["a"],
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
		recommendations: { clotho: ["a"], lachesis: ["a"], atropos: ["a"] },
		conflicts: [],
		excluded: [],
		abstentions: [],
		ranking: [{ optionKey: "a", rank: 1 }],
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
		candidates: [{ optionKey: "a", p0: 1, b: null }],
		eligibleDigest: judgmentDigest(["a"]),
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

test("fresh schema has exactly nine STRICT tables, metadata, WAL and unchanged DDL on reopen", () => {
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
		{ policyRevision: 999 },
	]) {
		test(`${status} resolution must match snapshot ${Object.keys(change)[0]}`, () => {
			const store = open();
			const ref = snapshot(store);
			store.openRound(ref);
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

test("assessment and selection use frozen refs after objective activation changes", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	const next = store.putObjectiveProfile(profile("clotho", 2));
	store.activateObjectiveProfile(ref.agentId, ref.scopeId, next);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const selection = spec(ref);
	expect(selection.assessmentSetDigest).toBe(
		judgmentDigest(store.assessmentSet(ref.roundId)),
	);
	store.recordResolution(ref.roundId, resolution(ref), selection);
	expect(store.getSelectionSpec(ref.roundId)).toEqual(selection);
	expect(store.getRound(ref.roundId)?.status).toBe("resolved");
});

test("resolution and selection persist atomically and survive reopen with canonical JSON", () => {
	let store = open();
	const ref = snapshot(store);
	store.openRound(ref);
	for (const m of MODULE_KINDS) store.putAssessment(assessment(ref, m));
	const record = resolution(ref);
	const selection = spec(ref);
	store.putIntention(intention());
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
	store.recordResolution(ref.roundId, resolution(ref, "deferred"), null);
	expect(store.getRound(ref.roundId)?.status).toBe("deferred");
	expect(store.getSelectionSpec(ref.roundId)).toBeNull();
	expect(store.getResolution("missing")).toBeNull();
});

test("SQLite failure during resolution rolls back the already inserted resolution", () => {
	const store = open();
	const ref = snapshot(store);
	store.openRound(ref);
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
	const ref = snapshot(store);
	store.openRound(ref);
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
	store.putIntention(intention());
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
