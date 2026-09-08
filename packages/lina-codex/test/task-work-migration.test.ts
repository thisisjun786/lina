import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../src/task-store.ts";
import { required } from "./task-work-fixture.ts";
import { TASK_V1_FIXTURE_SCHEMA } from "./task-work-v1-fixture.ts";

function legacy() {
	const dir = mkdtempSync(join(tmpdir(), "lina-work-migration-"));
	const path = join(dir, "tasks.sqlite");
	const db = new DatabaseSync(path);
	db.exec(TASK_V1_FIXTURE_SCHEMA);
	db.exec(
		"INSERT INTO task_meta VALUES ('schema_version','1'); PRAGMA user_version=1",
	);
	db.prepare(
		"INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		"task",
		"request",
		"kai",
		"title",
		"/tmp",
		"private",
		null,
		"thread",
		"waiting_approval",
		2,
		"date",
		"date",
		"turn",
		null,
		"lina",
		"digest",
		null,
		null,
		"pending",
		"notice",
		'["turn"]',
		'["request"]',
	);
	db.exec(
		"INSERT INTO task_requests VALUES ('request','task','create','digest'); INSERT INTO task_approvals VALUES ('approval','task','approval','{}','date')",
	);
	const rows = snapshot(db);
	db.close();
	return {
		path,
		rows,
		close: () => rmSync(dir, { recursive: true, force: true }),
	};
}
function snapshot(db: DatabaseSync) {
	return ["tasks", "task_requests", "task_approvals"].map((table) =>
		db.prepare(`SELECT * FROM ${table}`).all(),
	);
}
test("v1 migration preserves exact task, request, approval and pending-notice rows and grants no historic attribution", () => {
	const f = legacy();
	try {
		const store = new TaskStore(f.path);
		expect(store.workReceipts("task")).toEqual([]);
		expect(store.approvals("task")).toHaveLength(1);
		expect(store.pendingNotices()).toHaveLength(1);
		store.close();
		const db = new DatabaseSync(f.path);
		expect(
			required(db.prepare("PRAGMA user_version").get())["user_version"],
		).toBe(2);
		expect(snapshot(db)).toEqual(f.rows);
		db.close();
		const again = new TaskStore(f.path);
		expect(again.record("task").pendingApprovals).toHaveLength(1);
		again.close();
	} finally {
		f.close();
	}
});
test("invalid v1 rows reject before migration DDL", () => {
	const f = legacy();
	try {
		const db = new DatabaseSync(f.path);
		db.exec("UPDATE task_approvals SET params_json='broken'");
		db.close();
		expect(() => new TaskStore(f.path)).toThrow();
		const check = new DatabaseSync(f.path);
		expect(
			required(check.prepare("PRAGMA user_version").get())["user_version"],
		).toBe(1);
		expect(
			check
				.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'task_work_%'")
				.all(),
		).toEqual([]);
		check.close();
	} finally {
		f.close();
	}
});
test("failure in final v2 schema validation rolls all DDL and prior data back to v1", () => {
	const f = legacy();
	const original = DatabaseSync.prototype.exec;
	const hook = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			original.call(this, sql);
			if (sql === "PRAGMA user_version = 2")
				original.call(this, "CREATE TABLE unexpected(value TEXT) STRICT");
		},
	);
	try {
		expect(() => new TaskStore(f.path)).toThrow(/schema/);
		hook.mockRestore();
		const db = new DatabaseSync(f.path);
		expect(
			required(db.prepare("PRAGMA user_version").get())["user_version"],
		).toBe(1);
		expect(snapshot(db)).toEqual(f.rows);
		expect(
			db
				.prepare("SELECT name FROM sqlite_schema WHERE name='unexpected'")
				.all(),
		).toEqual([]);
		db.close();
	} finally {
		hook.mockRestore();
		f.close();
	}
});

test("legacy known terminal IDs remain unknown attribution on trusted reconcile", () => {
	const f = legacy();
	try {
		const store = new TaskStore(f.path);
		store.applyNative("task", {
			id: "thread",
			sessionId: null,
			model: null,
			cwd: "/tmp",
			status: { type: "idle" },
			source: null,
			name: null,
			preview: null,
			canAcceptDirectInput: null,
			turns: [
				{
					id: "turn",
					status: "completed",
					items: [
						{
							type: "userMessage",
							clientId: "request",
							ownerAgentId: "kai",
							participants: ["kai"],
						},
					],
					startedAt: null,
					completedAt: null,
					error: null,
				},
			],
		});
		expect(store.workReceipts("task")[0]).toMatchObject({
			ownerAgentId: null,
			participantAgentIds: [],
			attributionStatus: "unknown",
			outcome: "turn_ended",
		});
		store.close();
		const reopened = new TaskStore(f.path);
		expect(reopened.workReceipts("task")).toHaveLength(1);
		expect(reopened.approvals("task")).toHaveLength(1);
		reopened.close();
	} finally {
		f.close();
	}
});

test("unknown prior schema rejects without installing v2 tables", () => {
	const f = legacy();
	try {
		const db = new DatabaseSync(f.path);
		db.exec("ALTER TABLE tasks ADD COLUMN unknown TEXT");
		db.close();
		expect(() => new TaskStore(f.path)).toThrow(/schema/);
		const check = new DatabaseSync(f.path);
		expect(
			required(check.prepare("PRAGMA user_version").get())["user_version"],
		).toBe(1);
		expect(
			check
				.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'task_work_%'")
				.all(),
		).toEqual([]);
		check.close();
	} finally {
		f.close();
	}
});
