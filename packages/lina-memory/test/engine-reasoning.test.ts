import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import {
	contentHash,
	parseConclusions,
	prepareConclusions,
} from "../src/engine/reasoning.ts";
import { deriveRecord } from "../src/engine/records.ts";
import { EngineStore } from "../src/engine/store.ts";
import type { EngineRecord, SourceEntry } from "../src/engine/types.ts";
import { removeReasoningSchema } from "./fixtures/engine-v3.ts";
import { ordinarySource, restrictSource } from "./fixtures/native-sources.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0).reverse()) fn();
});
function persistentFixture() {
	const f = fixture();
	const root = mkdtempSync(join(tmpdir(), "lina-conclusions-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "test",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	const open = () => {
		const store = new EngineStore(join(root, "memory.sqlite"), binding, {
			lookup: f.lookup,
		});
		cleanups.push(() => store.close());
		return store;
	};
	const store = open();
	store.apply({
		requestId: "initial",
		expectedRevision: 0,
		sourceProofs: captureSourceProofs([...f.entries.keys()], f.lookup),
		observations: [f.a, f.b].map((r) => ({
			subject: r.subject,
			kind: r.kind,
			key: r.key,
			text: r.text,
			evidence: r.evidence,
			sources: r.sources,
		})),
	});
	const seed = {
		trigger: "a".repeat(64),
		stage: "induction" as const,
		page: 0,
		policyRevision: 0,
		modelSettingsRevision: 0,
		maxAttempts: 3,
	};
	return { ...f, store, open, seed, path: join(root, "memory.sqlite") };
}

function commitParksAndVisits(f: ReturnType<typeof persistentFixture>) {
	const first = f.store.beginReasoning({ ...f.seed, stage: "deduction" }, [
		f.a.id,
		f.b.id,
	]);
	if (!first) throw Error("missing claim");
	const deducted = f.store.applyConclusions({
		requestId: first.claim.id,
		expectedRevision: first.input.expectedRevision,
		proposals: [{ ...f.proposal, reasoningKind: "deduction" }],
		claim: first.claim,
	});
	const parent = deducted.records.find((r) => r.key === "parks");
	if (!parent) throw Error("missing parent");
	const second = f.store.beginReasoning(
		{ ...f.seed, trigger: "b".repeat(64) },
		[f.a.id, f.b.id, parent.id],
	);
	if (!second) throw Error("missing second claim");
	const induced = f.store.applyConclusions({
		requestId: second.claim.id,
		expectedRevision: second.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				key: "park.visits",
				text: "May like park visits",
				premises: [{ recordId: parent.id, revision: parent.revision }],
			},
		],
		claim: second.claim,
	});
	const child = induced.records.find((r) => r.key === "park.visits");
	if (!child) throw Error("missing child");
	return { parent, child };
}

function current(f: ReturnType<typeof persistentFixture>, key: string) {
	return f.store.state().records.find((r) => r.key === key);
}

function fixture() {
	const entries = new Map<string, SourceEntry>(
		["u1", "u2", "uncited"].map((id) => [
			id,
			ordinarySource({ entryId: id, role: "user", text: "I like walking." }),
		]),
	);
	const lookup = (id: string) => entries.get(id);
	const records = new Map<string, EngineRecord>();
	const add = (
		key: string,
		entryId: string,
		evidence: "explicit" | "inferred" = "explicit",
	) => {
		const record = {
			...deriveRecord(
				"lina",
				{
					subject: "user",
					kind: "interest",
					key,
					text: "Likes walking",
					evidence,
					sources: [{ entryId, quote: "walking" }],
				},
				undefined,
				1,
				1800000000000,
				lookup,
			),
			sourceRequestId: `observation-${key}`,
			sourceProofs: captureSourceProofs([entryId], lookup),
		};
		records.set(record.id, record);
		return record;
	};
	const a = add("walking", "u1");
	const b = add("outdoors", "u2");
	const proposal = {
		subject: "user" as const,
		kind: "interest" as const,
		key: "parks",
		text: "May enjoy parks",
		reasoningKind: "induction" as const,
		premises: [
			{ recordId: a.id, revision: a.revision },
			{ recordId: b.id, revision: b.revision },
		],
	};
	const prepare = (proposals: unknown = [proposal]) =>
		prepareConclusions({
			agentId: "lina",
			proposals,
			resolve: (id: string) => records.get(id),
			promptProofs: captureSourceProofs([...entries.keys()], lookup),
			lookup,
			now: 1800000000000,
		});
	return { entries, lookup, records, add, a, b, proposal, prepare };
}

test("strict proposals cannot forge provenance, identity or support", () => {
	const f = fixture();
	for (const extra of [
		{ sourceProofs: [] },
		{ support: "supported" },
		{ agentId: "other" },
		{ evidence: "explicit" },
		{ status: "retracted" },
	]) {
		expect(() => parseConclusions([{ ...f.proposal, ...extra }])).toThrow();
	}
	expect(() => parseConclusions([f.proposal, f.proposal])).toThrow(/duplicate/);
	expect(parseConclusions([])).toEqual([]);
});

test("induction stays provisional and binds uncited prompt context", () => {
	const f = fixture();
	const result = f.prepare()[0];
	expect(result?.support).toBe("provisional");
	expect(result?.sourceProofs.map((p) => p.entryId)).toEqual([
		"u1",
		"u2",
		"uncited",
	]);
	expect(result?.sources.map((s) => s.entryId)).toEqual(["u1", "u2"]);
	expect(result?.reasoning.premises[0]?.contentHash).toBe(contentHash(f.a));
	const inputProofs = captureSourceProofs([...f.entries.keys()], f.lookup);
	const uncited = f.entries.get("uncited");
	if (!uncited) throw Error("missing fixture source");
	restrictSource(uncited);
	expect(() =>
		prepareConclusions({
			agentId: "lina",
			proposals: [f.proposal],
			resolve: (id) => f.records.get(id),
			promptProofs: inputProofs,
			lookup: f.lookup,
			now: 1800000000000,
		}),
	).toThrow(/provenance/);
});

test("deduction support never exceeds its least certain premise", () => {
	const f = fixture();
	expect(
		f.prepare([{ ...f.proposal, reasoningKind: "deduction" }])[0]?.support,
	).toBe("supported");
	const uncertain = f.add("guess", "u1", "inferred");
	expect(
		f.prepare([
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [{ recordId: uncertain.id, revision: uncertain.revision }],
			},
		])[0]?.support,
	).toBe("provisional");
});

test("reconfirmation preserves content identity but correction changes it", () => {
	const f = fixture();
	expect(contentHash({ ...f.a, revision: 9, updatedAt: 1800000000010 })).toBe(
		contentHash(f.a),
	);
	expect(
		contentHash({ ...f.a, text: "Dislikes walking", generation: 1 }),
	).not.toBe(contentHash(f.a));
	expect(() =>
		f.prepare([
			{ ...f.proposal, premises: [{ recordId: f.a.id, revision: 0 }] },
		]),
	).toThrow(/revision/);
});

test("missing, foreign, expired and self premises are rejected", () => {
	const f = fixture();
	expect(() =>
		f.prepare([
			{ ...f.proposal, premises: [{ recordId: "missing", revision: 1 }] },
		]),
	).toThrow();
	f.records.set(f.a.id, { ...f.a, agentId: "other" });
	expect(() => f.prepare()).toThrow();
	f.records.set(f.a.id, { ...f.a, expiresAt: 1 });
	expect(() => f.prepare()).toThrow();
	f.records.set(f.a.id, f.a);
	expect(() =>
		f.prepare([
			{
				...f.proposal,
				key: f.a.key,
				premises: [{ recordId: f.a.id, revision: 1 }],
			},
		]),
	).toThrow(/cycle/);
});

test("a premise chain cannot hide a corrected ancestor or a cycle through an older revision", () => {
	const f = fixture();
	const derived = f.add("derived", "u1", "inferred");
	derived.reasoning = {
		kind: "deduction",
		premises: [
			{
				recordId: f.a.id,
				revision: f.a.revision,
				contentHash: contentHash(f.a),
			},
		],
	};
	const proposal = {
		...f.proposal,
		premises: [{ recordId: derived.id, revision: derived.revision }],
	};
	expect(f.prepare([proposal])).toHaveLength(1);
	f.records.set(f.a.id, {
		...f.a,
		text: "Now dislikes walking",
		generation: 1,
		revision: 2,
	});
	expect(() => f.prepare([proposal])).toThrow(/content/);
	f.records.set(f.a.id, f.a);
	expect(() => f.prepare([{ ...proposal, key: f.a.key }])).toThrow(/cycle/);
});

test("a batch cannot replace a premise used by another proposal", () => {
	const f = fixture();
	expect(() =>
		f.prepare([
			{
				...f.proposal,
				key: f.a.key,
				premises: [{ recordId: f.b.id, revision: f.b.revision }],
			},
			f.proposal,
		]),
	).toThrow(/batch/);
});

test("wide ancestry keeps bounded representative quotes and complete source proofs", () => {
	const f = fixture();
	const many = [];
	for (let i = 0; i < 65; i++) {
		const id = `wide-${i}`;
		f.entries.set(
			id,
			ordinarySource({ entryId: id, role: "user", text: "walking" }),
		);
		many.push({ entryId: id, quote: "walking" });
	}
	f.a.sources = many.slice(0, 64);
	f.a.sourceProofs = captureSourceProofs(
		many.slice(0, 64).map((s) => s.entryId),
		f.lookup,
	);
	f.b.sources = many.slice(64);
	f.b.sourceProofs = captureSourceProofs(
		many.slice(64).map((s) => s.entryId),
		f.lookup,
	);
	const prepared = f.prepare()[0];
	expect(prepared?.sources).toHaveLength(2);
	expect(prepared?.sourceProofs).toHaveLength(68);
});

test("a claimed conclusion commits once with its complete evidence and survives reopening", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("missing claim");
	const input = {
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [f.proposal],
		claim: started.claim,
	};
	const result = f.store.applyConclusions(input);
	expect(result.records.find((r) => r.key === "parks")).toMatchObject({
		support: "provisional",
		reasoning: { kind: "induction" },
	});
	expect(f.store.applyConclusions(input).revision).toBe(result.revision);
	expect(() =>
		f.store.applyConclusions({
			...input,
			proposals: [{ ...f.proposal, text: "different" }],
		}),
	).toThrow(/conflict/);
	f.store.close();
	expect(f.open().state().records).toEqual(result.records);
});

test("correcting a premise retracts its conclusion without forgetting the sibling premise", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [f.proposal],
		claim: started.claim,
	});
	f.entries.set(
		"correction",
		ordinarySource({
			entryId: "correction",
			role: "user",
			text: "I dislike walking now.",
		}),
	);
	f.store.apply({
		requestId: "correction",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["correction"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: f.a.key,
				text: "Dislikes walking",
				evidence: "explicit",
				sources: [{ entryId: "correction", quote: "dislike walking" }],
			},
		],
	});
	expect(f.store.state().records.some((r) => r.key === "parks")).toBe(false);
	expect(f.store.state().records.some((r) => r.id === f.b.id)).toBe(true);
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.some((r) => r.key === "parks"),
	).toBe(false);
});

test("forgetting one inference leaves its premises available and blocks same-evidence relearning", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("missing claim");
	const result = f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [f.proposal],
		claim: started.claim,
	});
	const conclusion = result.records.find((r) => r.key === "parks");
	if (!conclusion) throw Error("missing conclusion");
	f.store.retract(conclusion.id, result.revision);
	expect(
		f.store
			.state()
			.records.map((r) => r.id)
			.sort(),
	).toEqual([f.a.id, f.b.id].sort());
	expect(f.store.sourceInvalidated("u1")).toBe(false);
	const retry = f.store.beginReasoning({ ...f.seed, trigger: "b".repeat(64) }, [
		f.a.id,
		f.b.id,
	]);
	if (!retry) throw Error("missing claim");
	expect(() =>
		f.store.applyConclusions({
			requestId: retry.claim.id,
			expectedRevision: retry.input.expectedRevision,
			proposals: [f.proposal],
			claim: retry.claim,
		}),
	).toThrow(/invalidated/);
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.map((r) => r.id)
			.sort(),
	).toEqual([f.a.id, f.b.id].sort());
});

test("revoking uncited context during reasoning rejects commit without partial conclusions", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("missing claim");
	const uncited = f.entries.get("uncited");
	if (!uncited) throw Error("fixture");
	restrictSource(uncited);
	expect(() =>
		f.store.applyConclusions({
			requestId: started.claim.id,
			expectedRevision: started.input.expectedRevision,
			proposals: [f.proposal],
			claim: started.claim,
		}),
	).toThrow();
	expect(f.store.currentRevision()).toBe(started.input.expectedRevision);
	expect(f.store.recordCount()).toBe(2);
});

test("a conversational withdrawal of an inferred slot preserves original premises", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [f.proposal],
		claim: started.claim,
	});
	f.entries.set(
		"forget",
		ordinarySource({
			entryId: "forget",
			role: "user",
			text: "Forget that I like parks.",
		}),
	);
	f.store.apply({
		requestId: "forget",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["forget"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: "parks",
				text: "Forget parks",
				evidence: "explicit",
				status: "retracted",
				sources: [{ entryId: "forget", quote: "Forget" }],
			},
		],
	});
	expect(
		f.store
			.state()
			.records.map((r) => r.id)
			.sort(),
	).toEqual([f.a.id, f.b.id].sort());
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.map((r) => r.id)
			.sort(),
	).toEqual([f.a.id, f.b.id].sort());
});

test("a conclusion can cite a prior deduction and correction invalidates the grandchild", () => {
	const f = persistentFixture();
	const first = f.store.beginReasoning({ ...f.seed, stage: "deduction" }, [
		f.a.id,
		f.b.id,
	]);
	if (!first) throw Error("missing claim");
	const result = f.store.applyConclusions({
		requestId: first.claim.id,
		expectedRevision: first.input.expectedRevision,
		proposals: [{ ...f.proposal, reasoningKind: "deduction" }],
		claim: first.claim,
	});
	const parent = result.records.find((r) => r.key === "parks");
	if (!parent) throw Error("missing parent");
	const second = f.store.beginReasoning(f.seed, [f.a.id, f.b.id, parent.id]);
	if (!second) throw Error("missing second claim");
	f.store.applyConclusions({
		requestId: second.claim.id,
		expectedRevision: second.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				key: "park.visits",
				text: "May like park visits",
				premises: [{ recordId: parent.id, revision: parent.revision }],
			},
		],
		claim: second.claim,
	});
	expect(f.store.state().records.some((r) => r.key === "park.visits")).toBe(
		true,
	);
	f.entries.set(
		"changed",
		ordinarySource({
			entryId: "changed",
			role: "user",
			text: "Now dislike walking",
		}),
	);
	f.store.apply({
		requestId: "changed",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["changed"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: f.a.key,
				text: "Dislikes walking",
				evidence: "explicit",
				sources: [{ entryId: "changed", quote: "dislike walking" }],
			},
		],
	});
	expect(f.store.state().records.some((r) => r.key.startsWith("park"))).toBe(
		false,
	);
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.some((r) => r.key.startsWith("park")),
	).toBe(false);
});

test("fresh corroboration preserves the conclusion and its historical premise across restart", () => {
	const f = persistentFixture();
	const first = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!first) throw Error("claim");
	f.store.applyConclusions({
		requestId: first.claim.id,
		expectedRevision: first.input.expectedRevision,
		proposals: [f.proposal],
		claim: first.claim,
	});
	f.entries.set(
		"again",
		ordinarySource({ entryId: "again", role: "user", text: "walking" }),
	);
	f.store.apply({
		requestId: "again",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["again"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: f.a.key,
				text: f.a.text,
				evidence: "explicit",
				sources: [{ entryId: "again", quote: "walking" }],
			},
		],
	});
	expect(f.store.state().records.some((r) => r.key === "parks")).toBe(true);
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.some((r) => r.key === "parks"),
	).toBe(true);
});

test("an explicit source-backed fact cannot be overwritten by a conclusion", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("claim");
	const result = f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				key: f.a.key,
				premises: [{ recordId: f.b.id, revision: f.b.revision }],
			},
		],
		claim: started.claim,
	});
	expect(result.records.find((r) => r.id === f.a.id)).toMatchObject({
		text: f.a.text,
		evidence: "explicit",
	});
	expect(result.records).toHaveLength(2);
	f.store.close();
	expect(f.open().state().records).toEqual(result.records);
});

test("a cited deduction can validate ancestors outside the supplied prompt page", () => {
	const f = persistentFixture();
	const first = f.store.beginReasoning({ ...f.seed, stage: "deduction" }, [
		f.a.id,
		f.b.id,
	]);
	if (!first) throw Error("claim");
	const result = f.store.applyConclusions({
		requestId: first.claim.id,
		expectedRevision: first.input.expectedRevision,
		proposals: [{ ...f.proposal, reasoningKind: "deduction" }],
		claim: first.claim,
	});
	const parent = result.records.find((r) => r.key === "parks");
	if (!parent) throw Error("parent");
	const second = f.store.beginReasoning(f.seed, [parent.id]);
	if (!second) throw Error("claim");
	expect(
		f.store
			.applyConclusions({
				requestId: second.claim.id,
				expectedRevision: second.input.expectedRevision,
				claim: second.claim,
				proposals: [
					{
						...f.proposal,
						key: "park.visits",
						premises: [{ recordId: parent.id, revision: parent.revision }],
					},
				],
			})
			.records.some((r) => r.key === "park.visits"),
	).toBe(true);
});

test("reasoning over migrated current evidence preserves a divergent legacy history row", () => {
	const f = persistentFixture();
	const current = f.store.state().records[0];
	if (!current) throw Error("record");
	f.store.close();
	const db = new DatabaseSync(f.path);
	let legacy = "";
	try {
		removeReasoningSchema(db);
		const older = {
			...current,
			status: "retracted",
			generation: current.generation + 1,
			invalidatedAt: 1800000000000,
		};
		legacy = JSON.stringify(older);
		db.prepare(
			"INSERT OR REPLACE INTO engine_record_history VALUES (?,?,?)",
		).run(current.id, current.revision, legacy);
	} finally {
		db.close();
	}
	const reopened = f.open();
	const started = reopened.beginReasoning(f.seed, [current.id]);
	if (!started) throw Error("claim");
	reopened.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		claim: started.claim,
		proposals: [
			{
				...f.proposal,
				premises: [{ recordId: current.id, revision: current.revision }],
			},
		],
	});
	reopened.close();
	expect(
		f
			.open()
			.state()
			.records.some((record) => record.key === "parks"),
	).toBe(true);
	const inspect = new DatabaseSync(f.path);
	try {
		expect(
			inspect
				.prepare(
					"SELECT data FROM engine_record_history WHERE id=? AND revision=?",
				)
				.get(current.id, current.revision)?.["data"],
		).toBe(legacy);
	} finally {
		inspect.close();
	}
});

test("consolidation does not silently replace an eligible direct inferred observation", () => {
	const f = persistentFixture();
	f.store.apply({
		requestId: "direct-inference",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["u1"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: "parks",
				text: "Prefers quiet parks",
				evidence: "inferred",
				sources: [{ entryId: "u1", quote: "walking" }],
			},
		],
	});
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("claim");
	const result = f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		proposals: [f.proposal],
		claim: started.claim,
	});
	expect(result.records.find((record) => record.key === "parks")).toMatchObject(
		{ text: "Prefers quiet parks", sourceRequestId: "direct-inference" },
	);
});

test("one read validates a shared receipt once and the next read detects disk corruption", () => {
	const f = persistentFixture();
	const started = f.store.beginReasoning(f.seed, [f.a.id, f.b.id]);
	if (!started) throw Error("claim");
	f.store.applyConclusions({
		requestId: started.claim.id,
		expectedRevision: started.input.expectedRevision,
		claim: started.claim,
		proposals: [
			f.proposal,
			{
				...f.proposal,
				key: "parks.other",
				text: "Another tentative conclusion",
			},
		],
	});
	const original = DatabaseSync.prototype.prepare;
	let queries = 0;
	const spy = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			if (sql === "SELECT * FROM engine_reasoning_receipts WHERE request_id=?")
				queries++;
			return original.call(this, sql);
		},
	);
	try {
		expect(f.store.state().records).toHaveLength(4);
		expect(queries).toBe(1);
	} finally {
		spy.mockRestore();
	}
	const db = new DatabaseSync(f.path);
	try {
		db.prepare("UPDATE engine_reasoning_receipts SET fingerprint=?").run(
			"0".repeat(64),
		);
	} finally {
		db.close();
	}
	expect(() => f.store.state()).toThrow(/fingerprint/);
});

test("identical eligible conclusion reconfirmation keeps generation and descendants", () => {
	const f = persistentFixture();
	const { parent, child } = commitParksAndVisits(f);
	expect(parent.generation).toBe(0);
	expect(child.status).toBe("active");
	f.entries.set(
		"u3",
		ordinarySource({
			entryId: "u3",
			role: "user",
			text: "I enjoy reading.",
		}),
	);
	f.store.apply({
		requestId: "unrelated",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["u3"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: "reading",
				text: "Enjoys reading",
				evidence: "explicit",
				sources: [{ entryId: "u3", quote: "reading" }],
			},
		],
	});
	const walking = current(f, "walking");
	const outdoors = current(f, "outdoors");
	if (!walking || !outdoors) throw Error("missing premises");
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id, outdoors.id],
	);
	if (!again) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: again.claim.id,
		expectedRevision: again.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [
					{ recordId: walking.id, revision: walking.revision },
					{ recordId: outdoors.id, revision: outdoors.revision },
				],
			},
		],
		claim: again.claim,
	});
	expect(current(f, "parks")).toMatchObject({
		id: parent.id,
		generation: parent.generation,
		text: parent.text,
		status: "active",
	});
	expect(current(f, "park.visits")).toMatchObject({
		id: child.id,
		generation: child.generation,
		status: "active",
	});
	const empty = f.store.beginReasoning(
		{ ...f.seed, trigger: "d".repeat(64), stage: "induction" },
		[walking.id, outdoors.id, parent.id],
	);
	if (!empty) throw Error("missing empty induction");
	f.store.applyConclusions({
		requestId: empty.claim.id,
		expectedRevision: empty.input.expectedRevision,
		proposals: [],
		claim: empty.claim,
	});
	expect(current(f, "park.visits")).toMatchObject({
		id: child.id,
		status: "active",
	});
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.some((r) => r.id === child.id && r.status === "active"),
	).toBe(true);
});

test("premise corroboration then identical conclusion reconfirmation keeps descendants", () => {
	const f = persistentFixture();
	const { parent, child } = commitParksAndVisits(f);
	f.entries.set(
		"again",
		ordinarySource({ entryId: "again", role: "user", text: "walking" }),
	);
	f.store.apply({
		requestId: "again",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["again"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: f.a.key,
				text: f.a.text,
				evidence: "explicit",
				sources: [{ entryId: "again", quote: "walking" }],
			},
		],
	});
	const walking = current(f, "walking");
	const outdoors = current(f, "outdoors");
	if (!walking || !outdoors) throw Error("missing premises");
	expect(walking.revision).toBeGreaterThan(f.a.revision);
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id, outdoors.id],
	);
	if (!again) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: again.claim.id,
		expectedRevision: again.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [
					{ recordId: walking.id, revision: walking.revision },
					{ recordId: outdoors.id, revision: outdoors.revision },
				],
			},
		],
		claim: again.claim,
	});
	expect(current(f, "parks")).toMatchObject({
		id: parent.id,
		generation: parent.generation,
	});
	expect(current(f, "park.visits")).toMatchObject({
		id: child.id,
		status: "active",
	});
	expect(current(f, "parks")?.sources.map((s) => s.entryId)).toContain("again");
	expect(current(f, "parks")?.sourceProofs?.map((s) => s.entryId)).toContain(
		"again",
	);
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.find((r) => r.key === "park.visits")?.status,
	).toBe("active");
});

test("changing an eligible conclusion value invalidates descendants", () => {
	const f = persistentFixture();
	commitParksAndVisits(f);
	const walking = current(f, "walking");
	const outdoors = current(f, "outdoors");
	const parent = current(f, "parks");
	if (!walking || !outdoors || !parent) throw Error("missing records");
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id, outdoors.id],
	);
	if (!again) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: again.claim.id,
		expectedRevision: again.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				text: "Prefers indoor gardens",
				reasoningKind: "deduction",
				premises: [
					{ recordId: walking.id, revision: walking.revision },
					{ recordId: outdoors.id, revision: outdoors.revision },
				],
			},
		],
		claim: again.claim,
	});
	expect(current(f, "parks")).toMatchObject({
		text: "Prefers indoor gardens",
		generation: parent.generation + 1,
	});
	expect(current(f, "park.visits")).toBeUndefined();
});

test("changing conclusion premises invalidates descendants", () => {
	const f = persistentFixture();
	commitParksAndVisits(f);
	const walking = current(f, "walking");
	const parent = current(f, "parks");
	if (!walking || !parent) throw Error("missing records");
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id],
	);
	if (!again) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: again.claim.id,
		expectedRevision: again.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [{ recordId: walking.id, revision: walking.revision }],
			},
		],
		claim: again.claim,
	});
	expect(current(f, "parks")?.generation).toBe(parent.generation + 1);
	expect(current(f, "park.visits")).toBeUndefined();
});

test("revoking a conclusion invalidates descendants and blocks same-evidence relearning", () => {
	const f = persistentFixture();
	const { parent } = commitParksAndVisits(f);
	f.store.retract(parent.id, f.store.currentRevision());
	expect(current(f, "parks")).toBeUndefined();
	expect(current(f, "park.visits")).toBeUndefined();
	const retry = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[f.a.id, f.b.id],
	);
	if (!retry) throw Error("missing claim");
	expect(() =>
		f.store.applyConclusions({
			requestId: retry.claim.id,
			expectedRevision: retry.input.expectedRevision,
			proposals: [{ ...f.proposal, reasoningKind: "deduction" }],
			claim: retry.claim,
		}),
	).toThrow(/invalidated/);
	expect(current(f, "park.visits")).toBeUndefined();
});

test("identical reconfirmation still requires current source eligibility", () => {
	const f = persistentFixture();
	const { child } = commitParksAndVisits(f);
	const walking = current(f, "walking");
	const outdoors = current(f, "outdoors");
	if (!walking || !outdoors) throw Error("missing premises");
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id, outdoors.id],
	);
	if (!again) throw Error("missing claim");
	const uncited = f.entries.get("uncited");
	if (!uncited) throw Error("fixture");
	restrictSource(uncited);
	expect(() =>
		f.store.applyConclusions({
			requestId: again.claim.id,
			expectedRevision: again.input.expectedRevision,
			proposals: [
				{
					...f.proposal,
					reasoningKind: "deduction",
					premises: [
						{ recordId: walking.id, revision: walking.revision },
						{ recordId: outdoors.id, revision: outdoors.revision },
					],
				},
			],
			claim: again.claim,
		}),
	).toThrow();
	expect(f.store.currentRevision()).toBe(again.input.expectedRevision);
	const inspect = new DatabaseSync(f.path, { readOnly: true });
	try {
		expect(
			inspect
				.prepare("SELECT status FROM engine_records WHERE id=?")
				.get(child.id)?.["status"],
		).toBe("active");
	} finally {
		inspect.close();
	}
});

test("reordered identical premises preserve generation and descendants", () => {
	const f = persistentFixture();
	const { parent, child } = commitParksAndVisits(f);
	expect(parent.generation).toBe(0);
	expect(child.status).toBe("active");
	f.entries.set(
		"u3",
		ordinarySource({
			entryId: "u3",
			role: "user",
			text: "I enjoy reading.",
		}),
	);
	f.store.apply({
		requestId: "unrelated",
		expectedRevision: f.store.currentRevision(),
		sourceProofs: captureSourceProofs(["u3"], f.lookup),
		observations: [
			{
				subject: "user",
				kind: "interest",
				key: "reading",
				text: "Enjoys reading",
				evidence: "explicit",
				sources: [{ entryId: "u3", quote: "reading" }],
			},
		],
	});
	const walking = current(f, "walking");
	const outdoors = current(f, "outdoors");
	if (!walking || !outdoors) throw Error("missing premises");
	const again = f.store.beginReasoning(
		{ ...f.seed, trigger: "c".repeat(64), stage: "deduction" },
		[walking.id, outdoors.id],
	);
	if (!again) throw Error("missing claim");
	f.store.applyConclusions({
		requestId: again.claim.id,
		expectedRevision: again.input.expectedRevision,
		proposals: [
			{
				...f.proposal,
				reasoningKind: "deduction",
				premises: [
					{ recordId: outdoors.id, revision: outdoors.revision },
					{ recordId: walking.id, revision: walking.revision },
				],
			},
		],
		claim: again.claim,
	});
	expect(current(f, "parks")).toMatchObject({
		id: parent.id,
		generation: parent.generation,
		text: parent.text,
		status: "active",
	});
	expect(current(f, "park.visits")).toMatchObject({
		id: child.id,
		generation: child.generation,
		status: "active",
	});
	const empty = f.store.beginReasoning(
		{ ...f.seed, trigger: "d".repeat(64), stage: "induction" },
		[walking.id, outdoors.id, parent.id],
	);
	if (!empty) throw Error("missing empty induction");
	f.store.applyConclusions({
		requestId: empty.claim.id,
		expectedRevision: empty.input.expectedRevision,
		proposals: [],
		claim: empty.claim,
	});
	expect(current(f, "park.visits")).toMatchObject({
		id: child.id,
		status: "active",
	});
	f.store.close();
	expect(
		f
			.open()
			.state()
			.records.some((r) => r.id === child.id && r.status === "active"),
	).toBe(true);
});

for (const replacementFirst of [false, true]) {
	test(`a batch rejects transitive premise replacement before writes (${replacementFirst})`, () => {
		const f = persistentFixture();
		const { parent, child } = commitParksAndVisits(f);
		const walking = current(f, "walking");
		if (!walking) throw Error("missing walking");
		const before = f.store.state();
		const started = f.store.beginReasoning(
			{ ...f.seed, trigger: "c".repeat(64) },
			[walking.id, parent.id, child.id],
		);
		if (!started) throw Error("missing claim");
		const replacement = {
			...f.proposal,
			text: "May enjoy parks a lot",
			premises: [{ recordId: walking.id, revision: walking.revision }],
		};
		const dependent = {
			...f.proposal,
			key: "trails",
			text: "May enjoy trails",
			premises: [{ recordId: child.id, revision: child.revision }],
		};
		expect(() =>
			f.store.applyConclusions({
				requestId: started.claim.id,
				expectedRevision: started.input.expectedRevision,
				claim: started.claim,
				proposals: replacementFirst
					? [replacement, dependent]
					: [dependent, replacement],
			}),
		).toThrow("conclusion batch replaces a premise");
		// asOf is the read clock, not persisted state.
		expect(f.store.state()).toEqual({ ...before, asOf: expect.any(Number) });
		expect(
			f.store.reasoningJobs().find((job) => job.id === started.claim.id)?.state,
		).toBe("running");
		// A batch with independent premises remains valid in either order.
		const independent = { ...dependent, premises: replacement.premises };
		const result = f.store.applyConclusions({
			requestId: started.claim.id,
			expectedRevision: started.input.expectedRevision,
			claim: started.claim,
			proposals: replacementFirst
				? [replacement, independent]
				: [independent, replacement],
		});
		expect(result.records.map((record) => record.key).sort()).toEqual([
			"outdoors",
			"parks",
			"trails",
			"walking",
		]);
		expect(current(f, "trails")?.status).toBe("active");
		f.store.close();
		expect(
			f
				.open()
				.recall("trails")
				.map((record) => record.key),
		).toContain("trails");
	});
}
