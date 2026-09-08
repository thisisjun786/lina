import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	captureSourceProofs,
	type SourceEntry,
} from "../../lina-core/src/source-policy.ts";
import { buildObservationPrompt } from "../src/engine/prompt.ts";
import { EngineStore } from "../src/engine/store.ts";
import type { Observation } from "../src/engine/types.ts";
import { hash, validateSources } from "../src/engine/validation.ts";
import { removeReasoningSchema } from "./fixtures/engine-v3.ts";
import { ordinarySource, restrictSource } from "./fixtures/native-sources.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "work-memory-native-engine-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "fixture-session",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	const entries = new Map<string, SourceEntry>(
		["u", "a", "fresh"].map((id) => [
			id,
			ordinarySource({
				entryId: id,
				role: id === "a" ? "assistant" : "user",
				text: "tea",
			}),
		]),
	);
	const lookup = (id: string) => entries.get(id);
	const path = join(root, "engine.sqlite");
	const open = () => {
		const s = new EngineStore(path, binding, { lookup });
		cleanups.push(() => s.close());
		return s;
	};
	return { path, binding, entries, lookup, open };
}
function candidate(id = "u", key = "drink"): Observation {
	return {
		subject: "user",
		kind: "preference",
		key,
		text: "tea",
		evidence: "explicit",
		sources: [{ entryId: id, quote: "tea" }],
	};
}

test("repeating identical evidence commits processing without changing premise revision or ranking", () => {
	const f = fixture();
	const s = f.open();
	const sourceProofs = captureSourceProofs(["u"], f.lookup);
	const first = s.apply({
		requestId: "first-observation",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs,
	});
	const repeated = s.apply({
		requestId: "repeated-observation",
		expectedRevision: first.revision,
		observations: [candidate()],
		sourceProofs,
	});
	expect(repeated.revision).toBe(first.revision + 1);
	expect(repeated.records).toEqual(first.records);
	expect(s.hasReceipt("repeated-observation")).toBe(true);
	s.close();
	expect(f.open().state().records).toEqual(first.records);
});

test("changed evidence commits a durable reasoning marker, identical replay leaves it unchanged", () => {
	const f = fixture(),
		s = f.open();
	const sourceProofs = captureSourceProofs(["u"], f.lookup);
	s.apply({
		requestId: "changed",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs,
	});
	s.apply({
		requestId: "same",
		expectedRevision: 1,
		observations: [candidate()],
		sourceProofs,
	});
	s.close();
	const db = new DatabaseSync(f.path);
	try {
		expect(
			db
				.prepare("SELECT dirty_revision FROM engine_reasoning_checkpoint")
				.get()?.["dirty_revision"],
		).toBe(1);
	} finally {
		db.close();
	}
	expect(f.open().currentRevision()).toBe(2);
});

for (const legacy of [false, true])
	test(`multi-slot withdrawal preserves ${legacy ? "legacy v3 divergent" : "v4 consistent"} history on reopen`, () => {
		const f = fixture(),
			s = f.open();
		const first = s.apply({
			requestId: "initial",
			expectedRevision: 0,
			observations: [candidate("u", "one"), candidate("u", "two")],
			sourceProofs: captureSourceProofs(["u"], f.lookup),
		});
		const result = s.apply({
			requestId: "withdraw",
			expectedRevision: 1,
			observations: [
				{ ...candidate("fresh", "one"), status: "retracted" },
				{ ...candidate("fresh", "two"), status: "retracted" },
			],
			sourceProofs: captureSourceProofs(["fresh"], f.lookup),
		});
		s.close();
		if (legacy) {
			const db = new DatabaseSync(f.path);
			try {
				removeReasoningSchema(db);
				const original = first.records[0];
				if (!original) throw Error("missing original");
				const intermediate = {
					...original,
					status: "retracted",
					revision: result.revision,
					generation: original.generation + 1,
					updatedAt: Date.now(),
					invalidatedAt: Date.now(),
				};
				db.prepare(
					"INSERT OR REPLACE INTO engine_record_history VALUES (?,?,?)",
				).run(original.id, result.revision, JSON.stringify(intermediate));
			} finally {
				db.close();
			}
		}
		expect(f.open().snapshot().records).toEqual(result.records);
	});

for (const mode of ["read", "reopen"] as const)
	test(`N2: removing an assistant record proof rejects on ${mode}`, () => {
		const f = fixture(),
			s = f.open();
		s.apply({
			requestId: "proof-owner",
			expectedRevision: 0,
			observations: [candidate()],
			sourceProofs: captureSourceProofs(["u", "a"], f.lookup),
		});
		const db = new DatabaseSync(f.path);
		const row = db.prepare("SELECT id,data FROM engine_records").get();
		if (!row) throw Error("fixture");
		const record = JSON.parse(String(row["data"]));
		record.sourceProofs = record.sourceProofs.filter(
			(p: { entryId: string }) => p.entryId !== "a",
		);
		db.prepare("UPDATE engine_records SET data=? WHERE id=?").run(
			JSON.stringify(record),
			String(row["id"]),
		);
		db.close();
		restrictSource(required(f.entries.get("a")));
		expect(s.hasReceipt("proof-owner")).toBe(false);
		if (mode === "read") expect(() => s.recall("tea")).toThrow(/proof|receipt/);
		else {
			s.close();
			expect(() => f.open()).toThrow(/proof|receipt/);
		}
	});

test("N2: unquoted complete prompt context is bound to the record receipt", () => {
	const f = fixture(),
		s = f.open();
	s.apply({
		requestId: "with-context",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u", "a", "fresh"], f.lookup),
	});
	s.close();
	const reopened = f.open();
	expect(reopened.state().records[0]?.sourceRequestId).toBe("with-context");
	expect(reopened.state().records[0]?.sourceProofs).toHaveLength(3);
	const db = new DatabaseSync(f.path);
	const record = JSON.parse(
		String(db.prepare("SELECT data FROM engine_records").get()?.["data"]),
	);
	record.sourceProofs = record.sourceProofs.filter(
		(p: { entryId: string }) => p.entryId !== "fresh",
	);
	db.prepare("UPDATE engine_records SET data=?").run(JSON.stringify(record));
	db.close();
	restrictSource(required(f.entries.get("fresh")));
	expect(() => reopened.snapshot()).toThrow(/receipt proof/);
});

test("N2: unbound pre-link records remain byte-preserved and withheld while fresh ordinary learning progresses", () => {
	const f = fixture(),
		s = f.open();
	s.apply({
		requestId: "old",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u", "a"], f.lookup),
	});
	s.close();
	const db = new DatabaseSync(f.path);
	db.exec(
		"UPDATE engine_records SET data=json_remove(data,'$.sourceRequestId')",
	);
	const old = db.prepare("SELECT data FROM engine_records").get()?.["data"];
	db.close();
	const reopened = f.open();
	expect(reopened.state().records).toEqual([]);
	const check = new DatabaseSync(f.path);
	expect(check.prepare("SELECT data FROM engine_records").get()?.["data"]).toBe(
		old,
	);
	check.close();
	reopened.apply({
		requestId: "fresh",
		expectedRevision: 1,
		observations: [candidate("fresh")],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	});
	expect(reopened.state().records[0]?.sourceRequestId).toBe("fresh");
	reopened.close();
	expect(f.open().state().records[0]?.sourceRequestId).toBe("fresh");
});
test("mixed exact quotes and forged raw ordinary claims cannot validate", () => {
	const f = fixture();
	const entry = f.entries.get("u");
	if (!entry) throw Error("fixture");
	restrictSource(entry);
	expect(() => validateSources([candidate()], f.lookup)).toThrow();
	const forged = {
		...entry,
		sourcePolicy: undefined,
		raw: { sourcePolicy: ordinarySource(entry).sourcePolicy },
	};
	f.entries.set("u", forged);
	expect(() => validateSources([candidate()], f.lookup)).toThrow();
});
test("missing proofs cannot commit even an empty observer receipt", () => {
	const s = fixture().open();
	expect(() =>
		s.apply({ requestId: "u", expectedRevision: 0, observations: [] }),
	).toThrow();
	expect(s.hasReceipt("u")).toBe(false);
});
test("episode assistant proof withdraws user-only quote, receipt and stale prompt after reopen", () => {
	const f = fixture();
	const s = f.open();
	const input = {
		requestId: "u",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u", "a"], f.lookup),
	};
	s.apply(input);
	const captured = s.snapshot();
	expect(captured.records).toHaveLength(1);
	const assistant = f.entries.get("a");
	if (!assistant) throw Error("fixture");
	restrictSource(assistant);
	expect(s.state().records).toEqual([]);
	expect(s.recall("tea")).toEqual([]);
	expect(s.hasReceipt("u")).toBe(false);
	expect(() => s.apply(input)).toThrow();
	expect(
		buildObservationPrompt(
			[required(f.entries.get("fresh"))],
			captured,
			32000,
			f.lookup,
		),
	).not.toContain('"key":"drink"');
	s.close();
	const reopened = f.open();
	expect(reopened.snapshot().records).toEqual([]);
	expect(reopened.recordCount()).toBe(1);
	const db = new DatabaseSync(f.path);
	expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(4);
	db.close();
});
test("withheld explicit records cannot outrank fresh inference or consume the read limit", () => {
	const f = fixture();
	const s = f.open();
	s.apply({
		requestId: "fresh",
		expectedRevision: 0,
		observations: [candidate("fresh", "valid")],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	});
	for (let batch = 0; batch < 5; batch++)
		s.apply({
			requestId: `batch-${batch}`,
			expectedRevision: s.snapshot().revision,
			observations: Array.from({ length: 50 }, (_, i) =>
				candidate("u", `slot-${batch * 50 + i}`),
			),
			sourceProofs: captureSourceProofs(["u"], f.lookup),
		});
	const source = f.entries.get("u");
	if (!source) throw Error("fixture");
	restrictSource(source);
	expect(s.recall("tea", { limit: 1 })[0]?.key).toBe("valid");
	expect(s.snapshot().records).toHaveLength(1);
	expect(s.snapshot().truncated).toBe(false);
	s.apply({
		requestId: "replace",
		expectedRevision: s.snapshot().revision,
		observations: [{ ...candidate("fresh", "slot-1"), evidence: "inferred" }],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	});
	expect(s.state().records.find((r) => r.key === "slot-1")?.evidence).toBe(
		"inferred",
	);
});

test("accepted ordinary and changed ordinary revisions cannot revive a captured result", () => {
	const f = fixture(),
		s = f.open(),
		source = required(f.entries.get("u"));
	const sourceProofs = captureSourceProofs(["u"], f.lookup);
	source.requestStatus = "accepted";
	expect(() =>
		s.apply({
			requestId: "u",
			expectedRevision: 0,
			observations: [],
			sourceProofs,
		}),
	).toThrow();
	source.requestStatus = "settled";
	source.sourcePolicy = { ...required(source.sourcePolicy), policyRevision: 2 };
	expect(() =>
		s.apply({
			requestId: "u",
			expectedRevision: 0,
			observations: [],
			sourceProofs,
		}),
	).toThrow();
	expect(s.snapshot().revision).toBe(0);
});

test("explicit prior decisions retain their complete ancestry in the processing receipt", () => {
	const f = fixture(),
		s = f.open();
	s.apply({
		requestId: "first",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u", "a"], f.lookup),
	});
	const next = {
		requestId: "second",
		expectedRevision: 1,
		observations: [{ ...candidate("fresh"), evidence: "inferred" as const }],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	};
	s.apply(next);
	expect(s.hasReceipt("second")).toBe(true);
	s.close();
	const reopened = f.open();
	expect(reopened.apply(next).records[0]?.evidence).toBe("explicit");
	restrictSource(required(f.entries.get("a")));
	expect(reopened.hasReceipt("second")).toBe(false);
	expect(() => reopened.apply(next)).toThrow();
});

test("truncating persisted prior ancestry cannot produce a valid processing receipt after reopen", () => {
	const f = fixture(),
		s = f.open();
	s.apply({
		requestId: "first",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u", "a"], f.lookup),
	});
	s.apply({
		requestId: "second",
		expectedRevision: 1,
		observations: [{ ...candidate("fresh"), evidence: "inferred" }],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	});
	s.close();
	const db = new DatabaseSync(f.path);
	db.prepare(
		"UPDATE engine_request_sources SET source_proofs=input_source_proofs WHERE request_id='second'",
	).run();
	db.close();
	expect(() => f.open()).toThrow(/fingerprint/);
});
test("legacy engine v2 records and receipt bytes remain inspectable but cannot seed or merge", () => {
	const f = fixture(),
		s = f.open();
	s.apply({
		requestId: "u",
		expectedRevision: 0,
		observations: [candidate()],
		sourceProofs: captureSourceProofs(["u"], f.lookup),
	});
	s.close();
	const db = new DatabaseSync(f.path);
	removeReasoningSchema(db);
	db.exec(
		"DROP TABLE engine_request_sources; DROP TABLE engine_record_history; UPDATE engine_records SET data=json_remove(data,'$.sourceProofs','$.sourceRequestId'); PRAGMA user_version=2",
	);
	const data = db.prepare("SELECT data FROM engine_records").get()?.["data"];
	const observations = [{ ...candidate(), status: "active" }];
	db.prepare("UPDATE engine_receipts SET fingerprint=?").run(
		hash({ expectedRevision: 0, observations }),
	);
	const oldReceipt = db.prepare("SELECT * FROM engine_receipts").get();
	db.close();
	const reopened = f.open();
	expect(reopened.snapshot().records).toEqual([]);
	expect(reopened.hasReceipt("u")).toBe(false);
	const check = new DatabaseSync(f.path);
	expect(check.prepare("SELECT data FROM engine_records").get()?.["data"]).toBe(
		data,
	);
	expect(check.prepare("SELECT * FROM engine_receipts").get()).toEqual(
		oldReceipt,
	);
	check.close();
	reopened.apply({
		requestId: "fresh",
		expectedRevision: 1,
		observations: [{ ...candidate("fresh"), evidence: "inferred" }],
		sourceProofs: captureSourceProofs(["fresh"], f.lookup),
	});
	expect(reopened.state().records[0]?.support).toBe("provisional");
	const history = new DatabaseSync(f.path);
	expect(
		history.prepare("SELECT data FROM engine_record_history").get()?.["data"],
	).toBe(data);
	history.close();
});
test("engine migration audits final DDL before commit and leaves old schema on failure", () => {
	const f = fixture(),
		s = f.open();
	s.close();
	const db = new DatabaseSync(f.path);
	removeReasoningSchema(db);
	db.exec(
		"DROP TABLE engine_request_sources; DROP TABLE engine_record_history; PRAGMA user_version=2",
	);
	db.close();
	const original = DatabaseSync.prototype.exec;
	const patch = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			original.call(this, sql);
			if (sql.includes("CREATE TABLE engine_request_sources"))
				original.call(this, "CREATE TABLE corrupted_schema (x TEXT) STRICT");
		},
	);
	try {
		expect(() => f.open()).toThrow(/schema/);
	} finally {
		patch.mockRestore();
	}
	const check = new DatabaseSync(f.path);
	expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
	expect(
		check
			.prepare(
				"SELECT name FROM sqlite_schema WHERE name='engine_request_sources'",
			)
			.get(),
	).toBeUndefined();
	check.close();
});

function required<T>(value: T | undefined): T {
	if (value === undefined) throw Error("missing fixture value");
	return value;
}

test("empty observer results still require a user episode, not an ordinary tool flag", () => {
	const f = fixture(),
		s = f.open();
	f.entries.set(
		"tool",
		ordinarySource({ entryId: "tool", role: "tool", text: "tea" }),
	);
	expect(() =>
		s.apply({
			requestId: "tool",
			expectedRevision: 0,
			observations: [],
			sourceProofs: captureSourceProofs(["tool"], f.lookup),
		}),
	).toThrow();
	expect(() =>
		s.apply({
			requestId: "empty",
			expectedRevision: 0,
			observations: [],
			sourceProofs: [],
		}),
	).toThrow();
});
