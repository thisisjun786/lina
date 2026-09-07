import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

export const TASK_SCHEMA_VERSION = 1;

export const TASK_SCHEMA = `
CREATE TABLE task_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE tasks (
 id TEXT PRIMARY KEY,
 request_id TEXT NOT NULL,
 owner_agent_id TEXT NOT NULL,
 title TEXT NOT NULL,
 cwd TEXT NOT NULL,
 prompt TEXT NOT NULL,
 model TEXT,
 thread_id TEXT,
 status TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision >= 0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_turn_id TEXT,
 last_error TEXT,
 source TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 pending_kind TEXT,
 pending_request_id TEXT,
 notice_state TEXT NOT NULL,
 notice_key TEXT,
 known_turn_ids_json TEXT NOT NULL,
 known_message_ids_json TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX tasks_request_id ON tasks(request_id);
CREATE INDEX tasks_thread_id ON tasks(thread_id);
CREATE TABLE task_requests (
 request_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 kind TEXT NOT NULL,
 digest TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES tasks(id)
) STRICT;
CREATE TABLE task_approvals (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 method TEXT NOT NULL,
 params_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(task_id) REFERENCES tasks(id)
) STRICT;
`;

function statements(sql: string): string[] {
	return sql
		.split(";")
		.map((part) => part.trim().replace(/\s+/g, " "))
		.filter(Boolean);
}

export function initializeTaskSchema(db: DatabaseSync, fresh: boolean): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version !== 0 || tables.length) {
		if (version !== TASK_SCHEMA_VERSION)
			throw new Error("unknown task store schema");
		const actual = db
			.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
			.all()
			.map((row) => String(row["sql"]).trim().replace(/\s+/g, " "))
			.sort();
		const expected = statements(TASK_SCHEMA).sort();
		if (!isDeepStrictEqual(actual, expected))
			throw new Error("unknown task store schema");
		return;
	}
	if (!fresh) throw new Error("unknown task store schema");
	db.exec(TASK_SCHEMA);
	db.prepare(
		"INSERT INTO task_meta(key,value) VALUES ('schema_version',?)",
	).run(String(TASK_SCHEMA_VERSION));
	db.exec(`PRAGMA user_version = ${TASK_SCHEMA_VERSION}`);
}
