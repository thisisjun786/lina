import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding, HonchoIdentity } from "./types.ts";

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE parts (
	id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL, part_index INTEGER NOT NULL,
	role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','unknown','failed')),
	remote_id TEXT, error TEXT, UNIQUE(entry_id, part_index)
) STRICT;
CREATE INDEX open_parts ON parts(state, id) WHERE state IN ('pending','unknown');
CREATE TABLE scan (
	id INTEGER PRIMARY KEY CHECK(id = 1), after INTEGER NOT NULL,
	eligible_user INTEGER NOT NULL CHECK(eligible_user IN (0,1))
) STRICT;
`;
function verifySchema(db: DatabaseSync): void {
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const expected = SCHEMA.split(";").map(normalize).filter(Boolean).sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => normalize(String(row["sql"])))
		.sort();
	if (!isDeepStrictEqual(actual, expected))
		throw new Error("unknown outbox schema");
}

export function initializeOutbox(
	db: DatabaseSync,
	owner: { binding: BotBinding; identity: HonchoIdentity },
	fresh: boolean,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version !== 0 || tables.length > 0) {
		if (version !== SCHEMA_VERSION) throw new Error("unknown outbox schema");
		verifySchema(db);
		const saved = db
			.prepare("SELECT value FROM meta WHERE key = 'owner'")
			.get()?.["value"];
		if (
			typeof saved !== "string" ||
			!isDeepStrictEqual(JSON.parse(saved), owner)
		)
			throw new Error("foreign outbox owner");
		// A process that died while sending cannot know whether the POST landed.
		db.prepare(
			"UPDATE parts SET state = 'unknown', error = 'interrupted while sending' WHERE state = 'sending'",
		).run();
		return;
	}
	if (!fresh) throw new Error("unknown outbox schema");
	db.exec(SCHEMA);
	db.prepare("INSERT INTO meta(key, value) VALUES ('owner', ?)").run(
		JSON.stringify(owner),
	);
	db.prepare(
		"INSERT INTO scan(id, after, eligible_user) VALUES (1, 0, 0)",
	).run();
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
