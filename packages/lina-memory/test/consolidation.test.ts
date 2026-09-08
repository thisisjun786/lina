import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	CONSOLIDATION_SCHEMA,
	ConsolidationQueue,
} from "../src/engine/consolidation.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-consolidation-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "queue.sqlite");
	let now = 100;
	const open = (fresh = false) => {
		const db = new DatabaseSync(path);
		cleanup.push(() => db.close());
		if (fresh) db.exec(CONSOLIDATION_SCHEMA);
		return { db, queue: new ConsolidationQueue(db, () => now) };
	};
	return {
		open,
		advance: () => {
			now += 30000;
		},
	};
}
const seed = {
	trigger: "a".repeat(64),
	stage: "deduction" as const,
	page: 0,
	policyRevision: 0,
	modelSettingsRevision: 0,
	maxAttempts: 3,
};

test("job identity deduplicates enqueue and rejects changed bindings", () => {
	const f = fixture(),
		{ queue } = f.open(true);
	const a = queue.enqueue(seed);
	expect(queue.enqueue(seed).id).toBe(a.id);
	expect(() => queue.enqueue({ ...seed, maxAttempts: 2 })).toThrow(/conflict/);
	expect(queue.pending()).toHaveLength(1);
});

test("claim CAS prevents competing tokens; commit and restart preserve one outcome", () => {
	const f = fixture(),
		{ queue } = f.open(true);
	const job = queue.enqueue(seed);
	const claim = queue.claim(job.id);
	expect(claim).toBeDefined();
	if (!claim) throw Error("missing claim");
	expect(queue.claim(job.id)).toBeUndefined();
	expect(f.open().queue.claim(job.id)).toBeUndefined();
	expect(() =>
		queue.finish({ ...claim, token: "foreign" }, "committed", 7),
	).toThrow(/claim/);
	queue.finish(claim, "committed", 7);
	const reopened = f.open().queue;
	expect(reopened.get(job.id)?.resultRevision).toBe(7);
	expect(reopened.pending()).toHaveLength(0);
});

test("interrupted calls are marked unknown and retain their retry budget after reopen", () => {
	const f = fixture(),
		{ queue } = f.open(true);
	const job = queue.enqueue(seed);
	expect(queue.claim(job.id)).toBeDefined();
	const reopened = f.open().queue;
	reopened.recover(() => undefined);
	expect(reopened.get(job.id)?.attempts).toBe(1);
	expect(reopened.get(job.id)?.error).toBe("interrupted_outcome_unknown");
	for (let attempt = 2; attempt <= 3; attempt++) {
		f.advance();
		const claim = reopened.claim(job.id);
		if (!claim) throw Error("missing retry");
		expect(claim.attempt).toBe(attempt);
		reopened.finish(claim, "failed", null, "provider_failed");
	}
	f.advance();
	expect(reopened.pending()).toHaveLength(0);
	expect(reopened.claim(job.id)).toBeUndefined();
});

test("receipt reconciliation never repeats a committed result and supersession rejects late replies", () => {
	const f = fixture(),
		{ queue } = f.open(true);
	const job = queue.enqueue(seed);
	const claim = queue.claim(job.id);
	if (!claim) throw Error("missing claim");
	queue.recover((id) => (id === job.id ? 9 : undefined));
	expect(queue.get(job.id)?.state).toBe("committed");
	expect(queue.get(job.id)?.resultRevision).toBe(9);
	const next = queue.enqueue({ ...seed, trigger: "b".repeat(64) });
	const nextClaim = queue.claim(next.id);
	if (!nextClaim) throw Error("missing claim");
	queue.supersede("c".repeat(64));
	expect(() => queue.finish(nextClaim, "committed", 10)).toThrow(/claim/);
});

test("disk corruption is rejected before recovery changes any rows", () => {
	const f = fixture(),
		{ queue, db } = f.open(true);
	const job = queue.enqueue(seed);
	db.prepare("UPDATE engine_reasoning_jobs SET attempts=? WHERE id=?").run(
		Number.MAX_SAFE_INTEGER,
		job.id,
	);
	expect(() => f.open()).toThrow();
	expect(
		db.prepare("SELECT attempts FROM engine_reasoning_jobs").get()?.[
			"attempts"
		],
	).toBe(Number.MAX_SAFE_INTEGER);
});

test("job transitions join an outer owner transaction and roll back with its records", () => {
	const f = fixture(),
		{ queue, db } = f.open(true);
	db.exec("BEGIN IMMEDIATE");
	const discarded = queue.enqueue(seed);
	db.exec("ROLLBACK");
	expect(queue.get(discarded.id)).toBeUndefined();
	const job = queue.enqueue(seed);
	const claim = queue.claim(job.id);
	if (!claim) throw Error("missing claim");
	db.exec("BEGIN IMMEDIATE");
	queue.finish(claim, "committed", 2);
	db.exec("ROLLBACK");
	expect(queue.get(job.id)?.state).toBe("running");
	expect(queue.get(job.id)?.resultRevision).toBeNull();
});

test("a superseded trigger can reappear without recycling its consumed attempts", () => {
	const { queue } = fixture().open(true);
	const job = queue.enqueue(seed);
	expect(queue.claim(job.id)).toBeDefined();
	queue.supersede("b".repeat(64));
	expect(queue.enqueue(seed).state).toBe("pending");
	expect(queue.claim(job.id)?.attempt).toBe(2);
});

test("an unknown final attempt stays visibly failed instead of granting unlimited restart calls", () => {
	const f = fixture(),
		{ queue } = f.open(true);
	const job = queue.enqueue({ ...seed, maxAttempts: 1 });
	expect(queue.claim(job.id)).toBeDefined();
	const reopened = f.open().queue;
	reopened.recover(() => undefined);
	expect(reopened.get(job.id)).toMatchObject({
		state: "failed",
		attempts: 1,
		error: "interrupted_outcome_unknown",
		resultRevision: null,
	});
	f.advance();
	expect(reopened.claim(job.id)).toBeUndefined();
});
