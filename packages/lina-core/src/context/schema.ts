import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../protocol.ts";

export const CONTEXT_SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE summaries (
	id TEXT PRIMARY KEY, text TEXT NOT NULL,
	kind TEXT NOT NULL CHECK(kind IN ('model','extractive')),
	depth INTEGER NOT NULL CHECK(depth >= 0), fingerprint TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
) STRICT;
CREATE TABLE summary_sources (
	summary_id TEXT NOT NULL REFERENCES summaries(id),
	source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','summary')),
	source_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
	PRIMARY KEY (summary_id, ordinal)
) STRICT;
CREATE TABLE active_summary (
	id INTEGER PRIMARY KEY CHECK(id = 1),
	summary_id TEXT NOT NULL REFERENCES summaries(id),
	native_entry_id TEXT NOT NULL, first_kept_entry_id TEXT NOT NULL,
	revision INTEGER NOT NULL CHECK(revision >= 1)
) STRICT;
CREATE TABLE working_state (
	id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL CHECK(revision >= 0),
	goal TEXT NOT NULL, decisions TEXT NOT NULL, open_items TEXT NOT NULL,
	next_steps TEXT NOT NULL, source_entry_ids TEXT NOT NULL
) STRICT;
`;

const PROVENANCE_SCHEMA = `
CREATE TABLE summary_provenance (
	summary_id TEXT PRIMARY KEY REFERENCES summaries(id), source_proofs TEXT NOT NULL
) STRICT;
CREATE TABLE context_artifacts (
	id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('working','note')),
	content TEXT NOT NULL, creations TEXT NOT NULL, dependencies TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('pending','finalized','withheld')),
	reason TEXT NOT NULL, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE context_finalizations (
	artifact_id TEXT PRIMARY KEY REFERENCES context_artifacts(id),
	status TEXT NOT NULL CHECK(status IN ('finalized','withheld')),
	source_proofs TEXT NOT NULL, reason TEXT NOT NULL
) STRICT;
`;

const GENERATION_SCHEMA = `CREATE TABLE summary_generations (summary_id TEXT PRIMARY KEY REFERENCES summaries(id), generation_json TEXT NOT NULL) STRICT;`;

function verifySchema(db: DatabaseSync, version: number): void {
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const expected = (
		SCHEMA +
		(version >= 2 ? PROVENANCE_SCHEMA : "") +
		(version >= 3 ? GENERATION_SCHEMA : "")
	)
		.split(";")
		.map(normalize)
		.filter(Boolean)
		.sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => normalize(String(row["sql"])))
		.sort();
	if (!isDeepStrictEqual(actual, expected))
		throw new Error("unknown context store schema");
	const working = db.prepare("SELECT COUNT(*) AS n FROM working_state").get();
	if (working?.["n"] !== 1) throw new Error("corrupt context working state");
	if (db.prepare("PRAGMA foreign_key_check").all().length)
		throw Error("corrupt context relationships");
}

/** Runs inside the caller's transaction; the caller owns commit/rollback. */
export function initializeContextSchema(
	db: DatabaseSync,
	binding: BotBinding,
	fresh: boolean,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version !== 0 || tables.length > 0) {
		if (version !== 1 && version !== 2 && version !== CONTEXT_SCHEMA_VERSION)
			throw new Error("unknown context store schema");
		verifySchema(db, version);
		const schema = db
			.prepare("SELECT value FROM context_meta WHERE key = 'schema_version'")
			.get()?.["value"];
		if (schema !== String(version))
			throw new Error("unknown context store schema");
		const saved = db
			.prepare("SELECT value FROM context_meta WHERE key = 'binding'")
			.get()?.["value"];
		if (
			typeof saved !== "string" ||
			!isDeepStrictEqual(JSON.parse(saved), binding)
		)
			throw new Error("foreign context store binding");
		if (version === 1) {
			// Preserve all v1 bytes as human history; no proof is invented for old text.
			db.exec(PROVENANCE_SCHEMA);
			db.prepare(
				"UPDATE context_meta SET value = '2' WHERE key = 'schema_version'",
			).run();
			db.exec("PRAGMA user_version = 2");
		}
		if (version !== 3) {
			verifySchema(db, 2);
			db.exec(GENERATION_SCHEMA);
			db.exec(
				"UPDATE context_meta SET value='3' WHERE key='schema_version'; PRAGMA user_version=3",
			);
		}
		verifySchema(db, 3);
		return;
	}
	if (!fresh) throw new Error("unknown context store schema");
	db.exec(SCHEMA + PROVENANCE_SCHEMA + GENERATION_SCHEMA);
	const insert = db.prepare(
		"INSERT INTO context_meta(key, value) VALUES (?, ?)",
	);
	insert.run("schema_version", String(CONTEXT_SCHEMA_VERSION));
	insert.run("binding", JSON.stringify(binding));
	db.prepare(
		`INSERT INTO working_state (id, revision, goal, decisions, open_items, next_steps, source_entry_ids)
		VALUES (1, 0, '', '[]', '[]', '[]', '[]')`,
	).run();
	db.exec(`PRAGMA user_version = ${CONTEXT_SCHEMA_VERSION}`);
}
