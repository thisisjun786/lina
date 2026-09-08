import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { AGENT_LEARNING_SCHEMA } from "./agent-learning.ts";
import { auditLearning } from "./learning-audit.ts";
import {
	AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA,
	AGENT_VISUAL_SCHEMA,
} from "./visual-schema.ts";
export const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, personality TEXT NOT NULL, voice TEXT NOT NULL, profile TEXT NOT NULL, appearance TEXT NOT NULL, interests TEXT NOT NULL, avatar_id TEXT, evolution TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agent_dynamics (agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id), revision INTEGER NOT NULL, mood TEXT, interests TEXT NOT NULL, preferences TEXT NOT NULL, relationship TEXT NOT NULL, last_request_id TEXT) STRICT;
CREATE TABLE IF NOT EXISTS agent_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, created_at TEXT NOT NULL, source_entry_ids TEXT NOT NULL, summary TEXT NOT NULL, before_state TEXT, after_state TEXT, target_change_id INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS agent_receipts (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), request_id TEXT NOT NULL, PRIMARY KEY(agent_id, request_id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_authored_receipts (receipt_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), payload_hash TEXT NOT NULL, profile_json TEXT NOT NULL) STRICT;`;
export const CANDIDATE_SCHEMA = `CREATE TABLE IF NOT EXISTS agent_candidates (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, value TEXT NOT NULL, request_ids TEXT NOT NULL, PRIMARY KEY(agent_id, kind, value)) STRICT;`;

function verify(
	db: DatabaseSync,
	version: number,
	withoutCandidates = false,
	withoutAuthoredReceipts = false,
): void {
	const norm = (s: string) =>
		s
			.replace(/IF NOT EXISTS /g, "")
			.trim()
			.replace(/\s+/g, " ");
	const expected = (
		AGENT_SCHEMA +
		(withoutCandidates ? "" : CANDIDATE_SCHEMA) +
		(version >= 1 ? AGENT_LEARNING_SCHEMA : "") +
		(version === 2
			? AGENT_VISUAL_SCHEMA + AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA
			: "")
	)
		.split(";")
		.filter(
			(sql) =>
				!withoutAuthoredReceipts ||
				!sql.includes("CREATE TABLE IF NOT EXISTS agent_authored_receipts"),
		)
		.map(norm)
		.filter(Boolean)
		.sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((r) => norm(String(r["sql"])))
		.sort();
	if (![0, 1, 2].includes(version) || !isDeepStrictEqual(actual, expected))
		throw Error("unknown agent schema");
}
export function initializeAgents(
	db: DatabaseSync,
	audit: () => void,
	validateRaw: (value: unknown) => void,
	createVisuals: () => void,
	auditVisuals: () => void,
): void {
	const version = Number(
		db.prepare("PRAGMA user_version").get()?.["user_version"],
	);
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (!tables.length && version === 0) db.exec(AGENT_SCHEMA + CANDIDATE_SCHEMA);
	const withoutCandidates =
		version === 0 &&
		!db
			.prepare("SELECT 1 FROM sqlite_schema WHERE name='agent_candidates'")
			.get();
	const withoutAuthoredReceipts =
		version === 0 &&
		!db
			.prepare(
				"SELECT 1 FROM sqlite_schema WHERE name='agent_authored_receipts'",
			)
			.get();
	verify(db, version, withoutCandidates, withoutAuthoredReceipts);
	// The historical pre-authoring schema is supported only at version zero.
	// Validation precedes creating its missing receipt table inside the owner's transaction.
	if (withoutAuthoredReceipts) {
		const authored = AGENT_SCHEMA.split(";").find((sql) =>
			sql.includes("CREATE TABLE IF NOT EXISTS agent_authored_receipts"),
		);
		if (!authored) throw Error("Missing authored receipt schema");
		db.exec(authored);
	}
	audit();
	if (version === 0) {
		if (withoutCandidates) db.exec(CANDIDATE_SCHEMA);
		db.exec(AGENT_LEARNING_SCHEMA);
		db.exec("PRAGMA user_version=1");
	}
	verify(db, version === 2 ? 2 : 1);
	audit();
	// All schema1 records, including learning/candidate provenance, precede visual DDL.
	auditLearning(db, validateRaw);
	if (db.prepare("PRAGMA foreign_key_check").get())
		throw Error("invalid agent foreign key");
	if (version < 2) {
		db.exec(AGENT_VISUAL_SCHEMA + AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA);
		createVisuals();
		db.exec("PRAGMA user_version=2");
	}
	verify(db, 2);
	auditVisuals();
	if (db.prepare("PRAGMA foreign_key_check").get())
		throw Error("invalid agent foreign key");
}
