import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	AGENT_BEHAVIOR_SCHEMA,
	BehaviorStore,
} from "../src/agents/behavior-store.ts";
import type { BehaviorJobInput } from "../src/agents/behavior-types.ts";
import { behaviorDigest } from "../src/agents/behavior-validation.ts";

const HASH = "a".repeat(64);
const PROOFS = [{ entryId: "source", policyRevision: 1, policyDigest: HASH }];
const HASH_B = "b".repeat(64);

function digestOf(value: string): string {
	return behaviorDigest(value);
}

function input(patch: Partial<BehaviorJobInput> = {}): BehaviorJobInput {
	return {
		version: 1,
		agentId: "lina",
		worldId: "world",
		profileRevision: 1,
		definitionRevision: 1,
		projectionRevision: 1,
		policyRevision: 0,
		modelSettingsRevision: 0,
		definitionDigest: HASH,
		projectionDigest: HASH,
		promptDigest: HASH,
		maxAttempts: 2,
		records: [
			{
				recordId: "rec-1",
				revision: 3,
				contentHash: HASH,
				proofDigest: behaviorDigest(PROOFS),
				proofs: PROOFS,
			},
		],
		selectors: {
			traits: [{ axisId: "warmth", min: 0, max: 10 }],
			habits: [{ habitId: "tea" }],
		},
		...patch,
	};
}

function firstRecord() {
	const record = input().records[0];
	if (!record) throw Error("missing fixture record");
	return record;
}

function output() {
	return {
		traits: [{ axisId: "warmth", value: 7, evidenceIds: ["rec-1"] }],
		habits: [{ habitId: "tea", value: true, evidenceIds: ["rec-1"] }],
	};
}

let dir: string;
let db: DatabaseSync;
let store: BehaviorStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-behavior-"));
	db = new DatabaseSync(join(dir, "agents.sqlite"));
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(
		"CREATE TABLE agent_profiles (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, evolution TEXT NOT NULL) STRICT",
	);
	db.prepare("INSERT INTO agent_profiles VALUES (?,?,?)").run(
		"lina",
		1,
		"adaptive",
	);
	db.exec(AGENT_BEHAVIOR_SCHEMA);
	store = new BehaviorStore(
		db,
		(fn) => {
			db.exec("BEGIN");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		(id) => {
			const row = db
				.prepare(
					"SELECT id, revision, evolution FROM agent_profiles WHERE id=?",
				)
				.get(id);
			return row
				? {
						id: String(row["id"]),
						revision: Number(row["revision"]),
						evolution: row["evolution"] as "adaptive" | "manual",
					}
				: undefined;
		},
	);
});

afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});

test("enqueue deduplicates the same semantic fingerprint", () => {
	const first = store.enqueue(input());
	const second = store.enqueue(
		input({
			records: [{ ...firstRecord(), revision: 9 }],
			promptDigest: HASH_B,
		}),
	);
	expect(second.id).toBe(first.id);
	expect(second.state).toBe("pending");
	expect(store.status("lina")).toHaveLength(1);
});

test("commit stores typed output and current projection without evidence ids", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	const receipt = store.commit(claim, output(), () => true);
	expect(receipt.output).toEqual(output());
	expect(receipt.sourceStamp).toEqual({
		digest: expect.stringMatching(/^[a-f0-9]{64}$/),
		receiptRevision: 1,
		profileRevision: 1,
		definitionRevision: 1,
		projectionRevision: 1,
	});
	const current = store.current("lina", "world", () => true);
	expect(current.personalBehavior).toEqual({
		traits: [{ axisId: "warmth", value: 7 }],
		habits: [{ habitId: "tea", value: true }],
	});
	expect(current.sourceStamp).toMatchObject({
		receiptRevision: receipt.revision,
		profileRevision: 1,
	});
	expect(current.sourceStamp).toEqual(
		store.current("lina", "world", () => true).sourceStamp,
	);
	expect(JSON.stringify(current.personalBehavior)).not.toContain("evidenceIds");
});

test("empty output still writes a receipt and blocks replay", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	store.commit(claim, { traits: [], habits: [] }, () => true);
	expect(store.claim(job.id, 1)).toBeUndefined();
	expect(store.status("lina")[0]?.state).toBe("committed");
	expect(store.current("lina", "world", () => true).personalBehavior).toEqual({
		traits: [],
		habits: [],
	});
});

test("unknown ids, attitudes, text, and out-of-bounds values are rejected", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	expect(() =>
		store.commit(
			claim,
			{
				traits: [{ axisId: "unknown", value: 1, evidenceIds: ["rec-1"] }],
				habits: [],
			},
			() => true,
		),
	).toThrow(/unknown trait/);
	expect(() =>
		store.commit(
			claim,
			{
				traits: [{ axisId: "warmth", value: 99, evidenceIds: ["rec-1"] }],
				habits: [],
			},
			() => true,
		),
	).toThrow(/bounds/);
	expect(() =>
		store.commit(claim, { traits: [], habits: [], attitudes: [] }, () => true),
	).toThrow(/fields/);
	expect(() =>
		store.commit(claim, { traits: [], habits: [], text: "secret" }, () => true),
	).toThrow(/fields/);
	expect(store.status("lina")[0]?.state).toBe("prepared");
});

test("latest eligible value per dimension replaces rather than adds", () => {
	const first = store.enqueue(input());
	const firstClaim = store.claim(first.id, 0);
	if (!firstClaim) throw Error("missing claim");
	store.commit(firstClaim, output(), () => true);
	const next = store.enqueue(
		input({
			records: [
				{
					recordId: "rec-2",
					revision: 1,
					contentHash: HASH_B,
					proofDigest: behaviorDigest(PROOFS),
					proofs: PROOFS,
				},
			],
		}),
	);
	const nextClaim = store.claim(next.id, 1);
	if (!nextClaim) throw Error("missing claim");
	store.commit(
		nextClaim,
		{
			traits: [{ axisId: "warmth", value: 2, evidenceIds: ["rec-2"] }],
			habits: [{ habitId: "tea", value: false, evidenceIds: ["rec-2"] }],
		},
		() => true,
	);
	expect(store.current("lina", "world", () => true).personalBehavior).toEqual({
		traits: [{ axisId: "warmth", value: 2 }],
		habits: [{ habitId: "tea", value: false }],
	});
});

test("commit without a source verifier cannot publish a current projection", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	expect(() => store.commit(claim, output(), undefined as never)).toThrow(
		/current/,
	);
	expect(() => store.current("lina", "world", undefined as never)).toThrow(
		/current/,
	);
	expect(
		store.current("lina", "world", () => false).personalBehavior,
	).toBeNull();
});

test("prepared restart is unknown and consumes an attempt", () => {
	const job = store.enqueue(input());
	expect(store.claim(job.id, 0)?.attempt).toBe(1);
	store.recover();
	expect(store.status("lina")[0]).toMatchObject({
		state: "failed",
		attempts: 1,
		error: "interrupted_outcome_unknown",
	});
	const retry = store.claim(job.id, 0);
	expect(retry?.attempt).toBe(2);
	store.recover();
	expect(store.status("lina")[0]?.state).toBe("failed");
	expect(store.claim(job.id, 0)).toBeUndefined();
});

test("corrupt receipt is rejected on reopen", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	store.commit(claim, output(), () => true);
	db.prepare(
		"UPDATE agent_behavior_receipts SET output_json=? WHERE job_id=?",
	).run("{", job.id);
	expect(
		() =>
			new BehaviorStore(
				db,
				(fn) => {
					db.exec("BEGIN");
					try {
						const result = fn();
						db.exec("COMMIT");
						return result;
					} catch (error) {
						db.exec("ROLLBACK");
						throw error;
					}
				},
				() => ({ id: "lina", revision: 1, evolution: "adaptive" }),
			),
	).toThrow(/corrupt|invalid|JSON Parse/i);
});

test("reopen preserves committed receipt without nested transactions", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("missing claim");
	store.commit(claim, output(), () => true);
	const reopened = new BehaviorStore(
		db,
		(fn) => {
			if (db.isTransaction) throw Error("nested BEGIN");
			return fn();
		},
		() => ({ id: "lina", revision: 1, evolution: "adaptive" }),
	);
	expect(
		reopened.current("lina", "world", () => true).personalBehavior,
	).toEqual({
		traits: [{ axisId: "warmth", value: 7 }],
		habits: [{ habitId: "tea", value: true }],
	});
});

test("fingerprint identity ignores corroborating revision and prompt digest", () => {
	expect(digestOf("x")).toHaveLength(64);
	const first = store.enqueue(input({ promptDigest: HASH }));
	const second = store.enqueue(
		input({
			promptDigest: HASH_B,
			records: [{ ...firstRecord(), revision: 99 }],
		}),
	);
	expect(second.fingerprint).toBe(first.fingerprint);
});

test("withheld retries need a current verifier and retain consumed attempts", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("claim");
	store.fail(claim, "cancelled");
	expect(store.reactivate(job.id, () => false).state).toBe("withheld");
	expect(store.reactivate(job.id, () => true).attempts).toBe(1);
	const next = store.claim(job.id, 0);
	if (!next) throw Error("retry");
	store.fail(next, "cancelled");
	expect(store.reactivate(job.id, () => true).state).toBe("withheld");
	expect(store.claim(job.id, 0)).toBeUndefined();
});

test("receipt write failure rolls back atomically and independent worlds have separate revisions", () => {
	const job = store.enqueue(input());
	const claim = store.claim(job.id, 0);
	if (!claim) throw Error("claim");
	db.exec(
		"CREATE TRIGGER receipt_fail BEFORE INSERT ON agent_behavior_receipts BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END",
	);
	expect(() => store.commit(claim, output(), () => true)).toThrow(
		"forced receipt failure",
	);
	expect(store.get(job.id)?.state).toBe("prepared");
	expect(store.revision("lina", "world")).toBe(0);
	db.exec("DROP TRIGGER receipt_fail");
	store.commit(claim, output(), () => true);
	const other = store.enqueue(input({ worldId: "other-world" }));
	expect(store.revision("lina", "other-world")).toBe(0);
	expect(store.claim(other.id, 0)).toBeDefined();
});

test("a late interpretation cannot overwrite a newer committed behavior revision", () => {
	const first = store.enqueue(input()),
		second = store.enqueue(input({ modelSettingsRevision: 1 }));
	const a = store.claim(first.id, 0),
		b = store.claim(second.id, 0);
	if (!a || !b) throw Error("claims");
	store.commit(a, output(), () => true);
	expect(() => store.commit(b, output(), () => true)).toThrow(/stale/);
	expect(store.revision("lina", "world")).toBe(1);
});

test("startup rejects structurally valid tampered receipt values and contradictory job state", () => {
	const job = store.enqueue(input()),
		claim = store.claim(job.id, 0);
	if (!claim) throw Error("claim");
	store.commit(claim, output(), () => true);
	const before = db
		.prepare("SELECT output_json FROM agent_behavior_receipts")
		.get()?.["output_json"];
	if (typeof before !== "string") throw Error("missing receipt output");
	db.prepare("UPDATE agent_behavior_receipts SET output_json=?").run(
		JSON.stringify({
			traits: [{ axisId: "warmth", value: 1, evidenceIds: ["rec-1"] }],
			habits: [],
		}),
	);
	expect(() => store.audit()).toThrow();
	db.prepare("UPDATE agent_behavior_receipts SET output_json=?").run(before);
	db.exec(
		"UPDATE agent_behavior_jobs SET state='failed',error='provider_failed'",
	);
	expect(() => store.audit()).toThrow();
});

test("withdrawing a newer dimension never resurrects its older interpretation", () => {
	const a = store.enqueue(input()),
		ca = store.claim(a.id, 0);
	if (!ca) throw Error("claim");
	store.commit(ca, output(), () => true);
	const b = store.enqueue(input({ modelSettingsRevision: 1 })),
		cb = store.claim(b.id, 1);
	if (!cb) throw Error("claim");
	store.commit(
		cb,
		{
			traits: [{ axisId: "warmth", value: 2, evidenceIds: ["rec-1"] }],
			habits: [],
		},
		() => true,
	);
	const current = store.current(
		"lina",
		"world",
		(i) => i.modelSettingsRevision === 0,
	);
	expect(current.personalBehavior?.traits).toEqual([]);
	expect(current.personalBehavior?.habits).toEqual([
		{ habitId: "tea", value: true },
	]);
});
