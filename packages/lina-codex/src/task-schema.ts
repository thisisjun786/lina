import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { TASK_WORK_SCHEMA } from "./task-work-schema.ts";

export const TASK_SCHEMA_VERSION = 2;

export const TASK_SCHEMA_V1 = `
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

export const TASK_SCHEMA = TASK_SCHEMA_V1 + TASK_WORK_SCHEMA;

function validateSchema(db: DatabaseSync, version: number): void {
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => String(row["sql"]).trim().replace(/\s+/g, " "))
		.sort();
	const expected = statements(
		version === 1 ? TASK_SCHEMA_V1 : TASK_SCHEMA,
	).sort();
	if (!isDeepStrictEqual(actual, expected))
		throw new Error("unknown task store schema");
	const meta = db.prepare("SELECT key,value FROM task_meta").all();
	if (
		meta.length !== 1 ||
		meta[0]?.["key"] !== "schema_version" ||
		meta[0]?.["value"] !== String(version)
	)
		throw new Error("invalid task store schema metadata");
	if (db.prepare("PRAGMA foreign_key_check").all().length)
		throw new Error("orphan task store row");
}

/** Caller owns BEGIN/COMMIT: both old rows and final schema/rows validate before commit. */
export function initializeTaskSchema(
	db: DatabaseSync,
	fresh: boolean,
	validateRows: (version: number) => void,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version === 0 && tables.length === 0 && fresh) {
		db.exec(TASK_SCHEMA);
		db.prepare(
			"INSERT INTO task_meta(key,value) VALUES ('schema_version',?)",
		).run(String(TASK_SCHEMA_VERSION));
		db.exec(`PRAGMA user_version = ${TASK_SCHEMA_VERSION}`);
	} else {
		if (version !== 1 && version !== TASK_SCHEMA_VERSION)
			throw new Error("unknown task store schema");
		validateSchema(db, version);
		validateRows(version);
		if (version === 1) {
			db.exec(TASK_WORK_SCHEMA);
			db.prepare("UPDATE task_meta SET value=? WHERE key='schema_version'").run(
				String(TASK_SCHEMA_VERSION),
			);
			db.exec(`PRAGMA user_version = ${TASK_SCHEMA_VERSION}`);
		}
	}
	validateSchema(db, TASK_SCHEMA_VERSION);
	validateRows(TASK_SCHEMA_VERSION);
}
