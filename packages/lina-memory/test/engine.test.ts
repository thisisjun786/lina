/**
 * TDD evidence, 2026-09-06 (commands run from /path/to/Lina).
 * RED: bun test packages/lina-memory/test/engine.test.ts
 *   exit 1; 0 pass, 1 fail, 1 error: Cannot find module '../src/engine/store.ts'.
 * GREEN, same command: exit 0; 14 pass, 0 fail, 89 assertions.
 * Second RED, same command: exit 1; 15 pass, 2 fail, 94 assertions.
 *   "reopening rejects unknown persisted observation enums and mismatched source
 *   projection": Received function did not throw.
 *   "invalid derived expiry rolls back without a receipt or partial record":
 *   snapshot threw expiresAt ZodError after an invalid row had already committed.
 * Second GREEN, same command: exit 0; 17 pass, 0 fail, 97 assertions.
 * REFACTOR: bun test packages/lina-memory/test
 *   exit 0; 44 pass, 0 fail, 233 assertions. Original assertions retained.
 * bun run typecheck: exit 0.
 * bunx biome check --diagnostic-level=error packages/lina-memory/src/engine packages/lina-memory/test/engine.test.ts
 *   exit 0; 8 files checked.
 * Root bun test at this shared-workspace revision: 696 pass, 1 fail,
 *   packages/lina-runtime/test/session-policy.test.ts:45 (fleet settings forwarding).
 * Root bun run lint: exit 1; errors in concurrent lina-runtime changes, outside lane.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../../lina-core/src/protocol.ts";
import {
	captureSourceProofs,
	type SourceLookup,
} from "../../lina-core/src/source-policy.ts";
import {
	buildObservationPrompt,
	renderMemoryReference,
} from "../src/engine/prompt.ts";
import { EngineStore } from "../src/engine/store.ts";
import type {
	EngineOptions,
	Observation,
	SourceEntry,
} from "../src/engine/types.ts";
import { hash, parseObservations } from "../src/engine/validation.ts";
import { ordinarySource } from "./fixtures/native-sources.ts";

const roots: string[] = [];
const stores: EngineStore[] = [];
const lookups = new WeakMap<EngineStore, SourceLookup>();
function engine(path: string, binding: BotBinding, options: EngineOptions) {
	const store = new EngineStore(path, binding, options);
	lookups.set(store, options.lookup);
	return store;
}
function proofsFor(store: EngineStore) {
	const lookup = lookups.get(store);
	if (!lookup) throw Error("missing fixture lookup");
	return captureSourceProofs(
		["u1", "u2", "u3", "u4", "a1"].filter((id) => lookup(id)),
		lookup,
	);
}
function fixture(botId = "lina") {
	const root = mkdtempSync(join(tmpdir(), "lina-engine-"));
	roots.push(root);
	const binding: BotBinding = {
		version: 1,
		botId,
		sessionId: `room-${botId}`,
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	const entries = new Map<string, SourceEntry>([
		[
			"u1",
			{
				entryId: "u1",
				role: "user",
				text: "I enjoy hiking. I am worried about the exam.",
			},
		],
		[
			"u2",
			{
				entryId: "u2",
				role: "user",
				text: "I enjoy hiking. The exam is over now.",
			},
		],
		[
			"u3",
			{ entryId: "u3", role: "user", text: "Actually I prefer swimming." },
		],
		[
			"a1",
			{
				entryId: "a1",
				role: "assistant",
				text: "I feel hopeful about our hiking plans.",
			},
		],
		["t1", { entryId: "t1", role: "tool", text: "hiking" }],
		["m1", { entryId: "m1", role: "meta", text: "hiking" }],
		["n1", { entryId: "n1", role: undefined, text: "hiking" }],
	]);
	for (const [id, entry] of entries) entries.set(id, ordinarySource(entry));
	let time = 1_800_000_000_000;
	const path = join(root, "engine.sqlite");
	const options = { now: () => time, lookup: (id: string) => entries.get(id) };
	const open = () => {
		const s = engine(path, binding, options);
		stores.push(s);
		return s;
	};
	return {
		root,
		binding,
		path,
		entries,
		options,
		open,
		advance: (ms: number) => {
			time += ms;
		},
	};
}
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("missing fixture value");
	return value;
}
function observation(overrides: Partial<Observation> = {}): Observation {
	return {
		subject: "user",
		kind: "interest",
		key: "outdoors",
		text: "Enjoys hiking",
		evidence: "inferred",
		sources: [{ entryId: "u1", quote: "I enjoy hiking." }],
		...overrides,
	};
}
function apply(
	store: EngineStore,
	requestId: string,
	observations = [observation()],
) {
	return store.apply({
		sourceProofs: proofsFor(store),
		requestId,
		expectedRevision: store.snapshot().revision,
		observations,
	});
}
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("native EngineStore frozen contract", () => {
	// Receipt extension TDD (2026-09-06):
	// bun test packages/lina-memory/test/engine.test.ts --test-name-pattern hasReceipt
	// RED: exit 1, 0 pass/1 fail, "store.hasReceipt is not a function".
	// GREEN: exit 0, 1 pass/0 fail, 12 assertions.
	// Full engine file: 18 pass/0 fail, 109 assertions; typecheck and scoped lint pass.
	test("hasReceipt reads committed requests after reopen without mutation or cross-agent leakage", () => {
		const f = fixture();
		const store = f.open();
		expect(store.hasReceipt("settled")).toBe(false);
		apply(store, "settled");
		apply(store, "empty", []);
		expect(() =>
			apply(store, "rejected", [
				observation({ sources: [{ entryId: "missing", quote: "hiking" }] }),
			]),
		).toThrow();
		store.close();

		const reopened = f.open();
		const before = reopened.snapshot();
		expect(reopened.hasReceipt("settled")).toBe(true);
		expect(reopened.hasReceipt("empty")).toBe(true);
		expect(reopened.hasReceipt("rejected")).toBe(false);
		expect(reopened.hasReceipt("unknown")).toBe(false);
		expect(() => reopened.hasReceipt(" ")).toThrow();
		expect(() => reopened.hasReceipt("x".repeat(257))).toThrow();
		expect(reopened.snapshot()).toEqual(before);
		expect(fixture("other").open().hasReceipt("settled")).toBe(false);
		reopened.retract(required(before.records[0]).id, before.revision);
		expect(reopened.hasReceipt("settled")).toBe(true);
		reopened.close();
		expect(() => reopened.hasReceipt("settled")).toThrow(/closed/);
	});
	test("binds botId, reopens real SQLite, deduplicates receipts and separates two stores", () => {
		const f = fixture();
		const s = f.open();
		expect(s.agentId).toBe("lina");
		const input = {
			sourceProofs: proofsFor(s),
			requestId: "one",
			expectedRevision: 0,
			observations: [observation()],
		};
		s.apply(input);
		const saved = s.snapshot();
		expect(saved.revision).toBe(1);
		expect(saved.records[0]?.agentId).toBe("lina");
		s.close();
		const reopened = f.open();
		expect(reopened.snapshot()).toEqual(saved);
		reopened.apply(input);
		expect(reopened.snapshot()).toEqual(saved);
		expect(() =>
			reopened.apply({
				...input,
				observations: [observation({ text: "changed" })],
			}),
		).toThrow(/receipt/);
		expect(() =>
			engine(f.path, { ...f.binding, botId: "other" }, f.options),
		).toThrow(/binding/);
		expect(() =>
			engine(f.path, { ...f.binding, sessionId: "another" }, f.options),
		).toThrow(/binding/);
		const other = fixture("other").open();
		expect(other.snapshot().records).toEqual([]);
		expect(() => other.retract(required(saved.records[0]).id, 0)).toThrow(
			/unknown/,
		);
	});
	test("inferred user/self/relationship facets stay separate and need distinct originating entries", () => {
		const s = fixture().open();
		apply(s, "one", [
			observation(),
			observation({ subject: "self" }),
			observation({ subject: "relationship" }),
		]);
		expect(
			s
				.state()
				.records.map((r) => r.subject)
				.sort(),
		).toEqual(["relationship", "self", "user"]);
		expect(s.state().records.every((r) => r.support === "provisional")).toBe(
			true,
		);
		apply(s, "repeat");
		expect(s.state().records.find((r) => r.subject === "user")?.support).toBe(
			"provisional",
		);
		apply(s, "two", [
			observation({ sources: [{ entryId: "u2", quote: "I enjoy hiking." }] }),
		]);
		const user = required(s.state().records.find((r) => r.subject === "user"));
		expect(user.support).toBe("supported");
		expect(user.sources.map((s) => s.entryId).sort()).toEqual(["u1", "u2"]);
		expect(s.state().records.find((r) => r.subject === "self")?.support).toBe(
			"provisional",
		);
	});
	test("duplicate quotes within the same entry cannot promote inference", () => {
		const s = fixture().open();
		apply(s, "one", [
			observation({
				sources: [
					{ entryId: "u1", quote: "hiking" },
					{ entryId: "u1", quote: "I enjoy hiking." },
				],
			}),
		]);
		expect(s.state().records[0]?.support).toBe("provisional");
	});
	test("explicit user evidence requires user origin; self/relationship claims are always inferred", () => {
		const s = fixture().open();
		apply(s, "explicit", [observation({ evidence: "explicit" })]);
		expect(s.state().records[0]?.support).toBe("supported");
		for (const subject of ["self", "relationship"] as const)
			expect(() =>
				apply(s, subject, [observation({ subject, evidence: "explicit" })]),
			).toThrow();
		expect(() =>
			apply(s, "assistant", [
				observation({
					evidence: "explicit",
					sources: [{ entryId: "a1", quote: "hiking" }],
				}),
			]),
		).toThrow(/user/);
	});
	test("invalid quote, missing/mismatched source, tool/meta/undefined roles reject the whole batch", () => {
		const f = fixture();
		const s = f.open();
		f.entries.set("mismatch", {
			entryId: "someone-else",
			role: "user",
			text: "hiking",
		});
		for (const entryId of ["missing", "mismatch", "t1", "m1", "n1"]) {
			expect(() =>
				apply(s, entryId, [
					observation(),
					observation({ key: "bad", sources: [{ entryId, quote: "hiking" }] }),
				]),
			).toThrow();
			expect(s.snapshot()).toMatchObject({ revision: 0, records: [] });
		}
		expect(() =>
			apply(s, "quote", [
				observation({ sources: [{ entryId: "u1", quote: "never said this" }] }),
			]),
		).toThrow(/quote/);
		apply(s, "quote");
		expect(s.snapshot().revision).toBe(1);
	});
	test("correction supersedes old value, fences stale revision and previously invalidated sources", () => {
		const s = fixture().open();
		apply(s, "old");
		const before = s.snapshot();
		apply(s, "correction", [
			observation({
				text: "Prefers swimming",
				evidence: "explicit",
				sources: [{ entryId: "u3", quote: "Actually I prefer swimming." }],
			}),
		]);
		expect(s.state().records[0]?.text).toBe("Prefers swimming");
		expect(s.state().records[0]?.generation).toBe(1);
		expect(() =>
			s.apply({
				sourceProofs: proofsFor(s),
				requestId: "late",
				expectedRevision: before.revision,
				observations: [observation()],
			}),
		).toThrow(/revision/);
		expect(() => apply(s, "fresh-replay")).toThrow(/invalidated/);
		expect(s.recall("hiking")).toEqual([]);
	});
	test("retraction invalidates dependent facets, persists fences and blocks replay during in-flight derivation", () => {
		const f = fixture();
		const s = f.open();
		apply(s, "first", [
			observation(),
			observation({ subject: "relationship" }),
		]);
		const captured = s.snapshot();
		s.retract(required(captured.records[0]).id, captured.revision);
		expect(s.state().records).toEqual([]);
		expect(() =>
			s.apply({
				sourceProofs: proofsFor(s),
				requestId: "late",
				expectedRevision: captured.revision,
				observations: [observation()],
			}),
		).toThrow(/revision/);
		s.close();
		const reopened = f.open();
		expect(() => apply(reopened, "replay")).toThrow(/invalidated/);
		expect(reopened.recall("hiking")).toEqual([]);
		apply(reopened, "fresh", [
			observation({ sources: [{ entryId: "u2", quote: "I enjoy hiking." }] }),
		]);
		expect(reopened.state().records[0]?.support).toBe("provisional");
	});
	test("aborted and reentrantly invalidated applies never leave partial writes or receipts", () => {
		const f = fixture();
		const s = f.open();
		const control = new AbortController();
		control.abort();
		expect(() =>
			s.apply(
				{
					sourceProofs: proofsFor(s),
					requestId: "abort",
					expectedRevision: 0,
					observations: [observation()],
				},
				control.signal,
			),
		).toThrow();
		expect(s.snapshot().revision).toBe(0);
		apply(s, "abort");
		const original = f.options.lookup;
		let fire = true;
		const racing = engine(f.path, f.binding, {
			...f.options,
			lookup: (id) => {
				if (fire) {
					fire = false;
					s.retract(
						required(s.snapshot().records[0]).id,
						s.snapshot().revision,
					);
				}
				return original(id);
			},
		});
		stores.push(racing);
		expect(() =>
			racing.apply({
				sourceProofs: proofsFor(racing),
				requestId: "race",
				expectedRevision: 1,
				observations: [
					observation({ sources: [{ entryId: "u2", quote: "hiking" }] }),
				],
			}),
		).toThrow(/revision/);
		expect(racing.state().records).toEqual([]);
	});
	test("mood expires with injected clock and duplicate evidence cannot refresh TTL; concern stays open", () => {
		const f = fixture();
		const s = f.open();
		apply(s, "states", [
			observation({ kind: "mood", key: "mood" }),
			observation({ kind: "concern", key: "exam" }),
		]);
		const mood = required(s.state().records.find((r) => r.kind === "mood"));
		expect(mood.expiresAt).toBe(1_800_000_000_000 + 6 * 60 * 60 * 1000);
		f.advance(6 * 60 * 60 * 1000);
		apply(s, "repeat", [observation({ kind: "mood", key: "mood" })]);
		expect(s.state().records.map((r) => r.kind)).toEqual(["concern"]);
		expect(s.recall("hiking").map((r) => r.kind)).toEqual(["concern"]);
		expect(
			renderMemoryReference(s.snapshot(), 4000, lookups.get(s)),
		).not.toContain('"kind":"mood"');
		expect(() =>
			apply(s, "unsupported-resolve", [
				observation({
					kind: "concern",
					key: "exam",
					status: "resolved",
					sources: [{ entryId: "u1", quote: "exam" }],
				}),
			]),
		).toThrow();
		apply(s, "resolve", [
			observation({
				kind: "concern",
				key: "exam",
				status: "resolved",
				evidence: "explicit",
				sources: [{ entryId: "u2", quote: "The exam is over now." }],
			}),
		]);
		expect(s.state().records).toEqual([]);
		expect(s.snapshot().records.find((r) => r.kind === "concern")?.status).toBe(
			"resolved",
		);
	});
	test("semantic slot IDs are deterministic and bound to the agent", () => {
		const a = fixture().open();
		const b = fixture().open();
		const c = fixture("other").open();
		for (const s of [a, b, c]) apply(s, "first");
		expect(a.snapshot().records[0]?.id).toBe(b.snapshot().records[0]?.id);
		expect(c.snapshot().records[0]?.id).not.toBe(a.snapshot().records[0]?.id);
	});
	test("snapshot/recall and rendering have hard bounds and deterministic literal search", () => {
		const s = fixture().open();
		for (let batch = 0; batch < 5; batch++)
			apply(
				s,
				`batch-${batch}`,
				Array.from({ length: 50 }, (_, n) =>
					observation({
						key: `slot-${batch * 50 + n}`,
						text: `hiking ${batch * 50 + n}`,
					}),
				),
			);
		expect(s.snapshot().records.length).toBe(200);
		expect(s.snapshot().truncated).toBe(true);
		expect(s.recall("hiking", { limit: 3 })).toHaveLength(3);
		expect(s.recall("%", { limit: 3 })).toEqual([]);
		expect(s.recall("hiking", { limit: 10000 })).toHaveLength(200);
		expect(() => s.recall("hiking", { limit: NaN })).toThrow();
		for (const budget of [0, 1, 128, 1000])
			expect(
				renderMemoryReference(s.snapshot(), budget, lookups.get(s)).length,
			).toBeLessThanOrEqual(budget);
	});
	test("parser rejects unknown fields, invalid enums, oversize/empty fields and duplicate slots", () => {
		expect(parseObservations([observation()])).toEqual([
			observation({ status: "active" }),
		]);
		for (const candidate of [
			null,
			{},
			"[]",
			[{ ...observation(), surprise: true }],
			[observation({ key: "../bad" })],
			[observation({ sources: [] })],
			[observation({ text: " " })],
			[observation({ text: "x".repeat(2001) })],
			[{ ...observation(), subject: "system" }],
			[observation(), observation()],
		])
			expect(() => parseObservations(candidate)).toThrow();
		const s = fixture().open();
		expect(() =>
			s.apply({
				sourceProofs: proofsFor(s),
				requestId: "invalid",
				expectedRevision: 0,
				observations: [{ ...observation(), extra: true }],
			} as never),
		).toThrow();
		expect(s.snapshot().revision).toBe(0);
	});
	test("pure prompt encloses bounded source data and reference records cannot claim authored authority", () => {
		const f = fixture();
		const s = f.open();
		apply(s, "one");
		const prompt = buildObservationPrompt(
			[required(f.entries.get("u1"))],
			s.snapshot(),
			8000,
			f.options.lookup,
		);
		expect(prompt).toContain("u1");
		expect(prompt).toContain("I enjoy hiking.");
		expect(prompt.length).toBeLessThanOrEqual(8000);
		const reference = renderMemoryReference(s.snapshot(), 4000, lookups.get(s));
		expect(reference).toContain("reference-only");
		expect(reference).toContain("provisional");
		expect(reference).toContain("authored core");
		expect(reference).toContain("explicit preferences");
		expect(() =>
			buildObservationPrompt(
				[required(f.entries.get("u1"))],
				s.snapshot(),
				10,
				f.options.lookup,
			),
		).toThrow(/budget/);
	});
	test("reopening rejects unknown persisted observation enums and mismatched source projection", () => {
		for (const corrupt of [
			"UPDATE engine_observations SET data = json_set(data, '$.subject', 'system')",
			"UPDATE engine_sources SET entry_id = 'uncited-entry'",
			"UPDATE engine_records SET data = json_set(data, '$.kind', 'unknown')",
		]) {
			const f = fixture();
			const s = f.open();
			apply(s, "first");
			s.close();
			const db = new DatabaseSync(f.path);
			db.exec(corrupt);
			db.close();
			expect(() => f.open()).toThrow();
		}
	});
	test("invalid derived expiry rolls back without a receipt or partial record", () => {
		const f = fixture();
		const s = engine(f.path, f.binding, {
			...f.options,
			now: () => 8_640_000_000_000_000,
		});
		stores.push(s);
		expect(() =>
			apply(s, "overflow", [observation({ kind: "mood" })]),
		).toThrow();
		expect(s.snapshot()).toMatchObject({ revision: 0, records: [] });
	});
	test("abort signaled during lookup leaves zero mutation and allows a later retry", () => {
		const f = fixture();
		const control = new AbortController();
		const s = engine(f.path, f.binding, {
			...f.options,
			lookup: (id) => {
				control.abort();
				return f.options.lookup(id);
			},
		});
		stores.push(s);
		expect(() =>
			s.apply(
				{
					sourceProofs: proofsFor(s),
					requestId: "lookup-abort",
					expectedRevision: 0,
					observations: [observation()],
				},
				control.signal,
			),
		).toThrow();
		expect(s.snapshot()).toMatchObject({ revision: 0, records: [] });
		apply(s, "lookup-abort");
		expect(s.snapshot().revision).toBe(1);
	});
	test("unknown schema or persisted enums refuse reopening rather than migrating", () => {
		const f = fixture();
		const s = f.open();
		apply(s, "first");
		s.close();
		const db = new DatabaseSync(f.path);
		db.exec("PRAGMA user_version = 999");
		db.close();
		expect(() => f.open()).toThrow(/schema/);
		const check = new DatabaseSync(f.path);
		expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
			999,
		);
		check.close();
	});
});

test("one user and its assistant reply cannot confirm a durable self interest", () => {
	const f = fixture();
	const s = f.open();
	apply(s, "episode", [
		observation({
			subject: "self",
			sources: [
				{ entryId: "u1", quote: "hiking" },
				{ entryId: "a1", quote: "hiking" },
			],
		}),
	]);
	expect(s.state().records[0]?.support).toBe("provisional");
});

test("a later weak inference cannot replace an explicit user correction", () => {
	const f = fixture();
	const s = f.open();
	apply(s, "explicit", [
		observation({
			evidence: "explicit",
			text: "Prefers swimming",
			sources: [{ entryId: "u3", quote: "swimming" }],
		}),
	]);
	apply(s, "weak", [
		observation({
			text: "Enjoys hiking",
			sources: [{ entryId: "u2", quote: "hiking" }],
		}),
	]);
	expect(s.state().records[0]?.text).toBe("Prefers swimming");
	expect(s.state().records[0]?.evidence).toBe("explicit");
});

test("recovered older explicit evidence cannot retract a newer correction", () => {
	const f = fixture();
	const s = engine(f.path, f.binding, {
		...f.options,
		sourceSequence: (id) => ({ u1: 1, u2: 2, u3: 3 })[id],
	});
	stores.push(s);
	apply(s, "new", [
		observation({
			evidence: "explicit",
			text: "Prefers swimming",
			sources: [{ entryId: "u3", quote: "swimming" }],
		}),
	]);
	apply(s, "old", [observation({ evidence: "explicit" })]);
	expect(s.state().records[0]?.text).toBe("Prefers swimming");
	expect(s.sourceInvalidated("u3")).toBe(false);
});

test("backfilled mood expires from its source time, not processing time", () => {
	const f = fixture();
	f.entries.set(
		"u1",
		ordinarySource({
			entryId: "u1",
			role: "user",
			text: "nervous",
			timestamp: "2020-01-01T00:00:00.000Z",
		}),
	);
	const s = f.open();
	apply(s, "old-mood", [
		observation({
			kind: "mood",
			evidence: "explicit",
			text: "nervous",
			sources: [{ entryId: "u1", quote: "nervous" }],
		}),
	]);
	expect(s.snapshot().records).toHaveLength(1);
	expect(s.state().records).toEqual([]);
});

test("explicit conversational withdrawal retracts its slot and fences replay", () => {
	const f = fixture();
	const s = f.open();
	apply(s, "first", [observation({ evidence: "explicit" })]);
	f.entries.set(
		"u4",
		ordinarySource({
			entryId: "u4",
			role: "user",
			text: "Forget that hiking preference",
		}),
	);
	apply(s, "withdraw", [
		observation({
			evidence: "explicit",
			status: "retracted",
			text: "Withdrawn hiking preference",
			sources: [{ entryId: "u4", quote: "Forget that hiking preference" }],
		}),
	]);
	expect(s.state().records).toEqual([]);
	expect(s.snapshot().records[0]?.status).toBe("retracted");
	expect(() =>
		apply(s, "replay", [observation({ evidence: "explicit" })]),
	).toThrow();
});

test("correcting one slot preserves independent memories from the same original message", () => {
	const f = fixture();
	const s = f.open();
	apply(s, "first", [
		observation({ evidence: "explicit" }),
		observation({
			kind: "concern",
			key: "exam",
			text: "Exam concern",
			evidence: "explicit",
			sources: [{ entryId: "u1", quote: "worried about the exam" }],
		}),
	]);
	apply(s, "correct", [
		observation({
			evidence: "explicit",
			text: "Prefers swimming",
			sources: [{ entryId: "u3", quote: "swimming" }],
		}),
	]);
	expect(s.state().records.some((r) => r.key === "exam")).toBe(true);
	s.close();
	const reopened = f.open();
	expect(reopened.state().records).toHaveLength(2);
	expect(() =>
		apply(reopened, "old-replay", [observation({ evidence: "explicit" })]),
	).toThrow();
});

test("exact v1 engine migration retains records, sources and receipt fingerprints", () => {
	const f = fixture();
	const s = f.open();
	apply(s, "r");
	const before = s.snapshot();
	s.close();
	const db = new DatabaseSync(f.path);
	db.exec(
		"DROP TABLE engine_slot_fences; DROP TABLE engine_request_sources; DROP TABLE engine_record_history; UPDATE engine_records SET data=json_remove(data, '$.sourceProofs', '$.sourceRequestId'); PRAGMA user_version=1",
	);
	const old = {
		expectedRevision: 0,
		observations: [{ ...observation(), status: "active" }],
	};
	db.prepare("UPDATE engine_receipts SET fingerprint=?").run(hash(old));
	db.close();
	const reopened = f.open();
	expect(reopened.snapshot()).toMatchObject({
		revision: before.revision,
		records: [],
	});
	expect(reopened.recordCount()).toBe(1);
	expect(reopened.hasReceipt("r")).toBe(false);
});
