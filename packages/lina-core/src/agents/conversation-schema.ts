import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
export const CONVERSATION_SCHEMA = `
CREATE TABLE conversation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE conversation_profiles (agent_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 1), style TEXT NOT NULL, examples_json TEXT NOT NULL) STRICT;
CREATE TABLE conversation_preferences (agent_id TEXT NOT NULL, dimension TEXT NOT NULL, value TEXT NOT NULL, quote TEXT NOT NULL, source_entry_id TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY(agent_id, dimension)) STRICT;
CREATE TABLE conversation_preference_receipts (agent_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(agent_id, request_id)) STRICT;
`;

const PROVENANCE_SCHEMA = `
CREATE TABLE conversation_preference_sources (agent_id TEXT NOT NULL, request_id TEXT NOT NULL, source_proofs TEXT NOT NULL, PRIMARY KEY(agent_id,request_id), FOREIGN KEY(agent_id,request_id) REFERENCES conversation_preference_receipts(agent_id,request_id)) STRICT;
CREATE TABLE conversation_preference_history (seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), event TEXT NOT NULL CHECK(event IN ('observe','reset')), data TEXT NOT NULL) STRICT;
`;
function verify(db: DatabaseSync, version: number): void {
	const norm = (s: string) => s.trim().replace(/\s+/g, " ");
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((r) => norm(String(r["sql"])))
		.sort();
	const expected = (
		CONVERSATION_SCHEMA + (version === 2 ? PROVENANCE_SCHEMA : "")
	)
		.split(";")
		.map(norm)
		.filter(Boolean)
		.sort();
	if (
		![1, 2].includes(version) ||
		!isDeepStrictEqual(actual, expected) ||
		db
			.prepare("SELECT value FROM conversation_meta WHERE key='schema_version'")
			.get()?.["value"] !== String(version)
	)
		throw Error("unknown conversation store schema");
}
export function initializeConversation(
	db: DatabaseSync,
	fresh: boolean,
	audit: (version: number) => void,
): void {
	if (fresh) {
		db.exec(CONVERSATION_SCHEMA);
		db.prepare(
			"INSERT INTO conversation_meta VALUES('schema_version','1')",
		).run();
		db.exec("PRAGMA user_version=1");
	}
	const version = Number(
		db.prepare("PRAGMA user_version").get()?.["user_version"],
	);
	verify(db, version);
	audit(version);
	if (version === 1) {
		db.exec(PROVENANCE_SCHEMA);
		db.exec(
			"UPDATE conversation_meta SET value='2' WHERE key='schema_version'; PRAGMA user_version=2",
		);
	}
	verify(db, 2);
	audit(2);
	if (db.prepare("PRAGMA foreign_key_check").get())
		throw Error("invalid conversation foreign key");
}
