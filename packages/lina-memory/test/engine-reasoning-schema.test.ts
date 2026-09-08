import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConsolidationQueue } from "../src/engine/consolidation.ts";
import { EngineStore } from "../src/engine/store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-reasoning-schema-"));
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "mind.sqlite");
	const binding = {
		version: 1 as const,
		botId: "lina",
		sessionId: "fixture",
		sessionFile: join(root, "session.jsonl"),
		workspace: root,
	};
	const open = () => {
		const s = new EngineStore(path, binding, { lookup: () => undefined });
		cleanup.push(() => s.close());
		return s;
	};
	return { path, open };
}
test("fresh memory owns the v4 reasoning schema and checkpoint across reopen", () => {
	const f = fixture();
	f.open().close();
	const db = new DatabaseSync(f.path);
	try {
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(4);
		expect(
			db
				.prepare(
					"SELECT dirty_revision FROM engine_reasoning_checkpoint WHERE id=1",
				)
				.get()?.["dirty_revision"],
		).toBe(0);
		expect(
			db
				.prepare(
					"SELECT value FROM engine_meta WHERE key='reasoning_migration_revision'",
				)
				.get()?.["value"],
		).toBe("0");
	} finally {
		db.close();
	}
	expect(f.open().state().records).toEqual([]);
});
test("invalid reasoning checkpoint fails before enabling the store", () => {
	const f = fixture();
	f.open().close();
	const db = new DatabaseSync(f.path);
	try {
		db.prepare("UPDATE engine_reasoning_checkpoint SET dirty_revision=?").run(
			Number.MAX_SAFE_INTEGER,
		);
	} finally {
		db.close();
	}
	expect(() => f.open()).toThrow();
});
test("a malformed conclusion receipt cannot pass startup just because its job exists", () => {
	const f = fixture();
	f.open().close();
	const db = new DatabaseSync(f.path);
	try {
		const job = new ConsolidationQueue(db).enqueue({
			trigger: "a".repeat(64),
			stage: "deduction",
			page: 0,
			policyRevision: 0,
			modelSettingsRevision: 0,
			maxAttempts: 3,
		});
		db.prepare(
			"INSERT INTO engine_reasoning_receipts VALUES (?,?,?,?,?,'unchanged')",
		).run(job.id, "a".repeat(64), "{}", "{}", 0);
	} finally {
		db.close();
	}
	expect(() => f.open()).toThrow();
});
