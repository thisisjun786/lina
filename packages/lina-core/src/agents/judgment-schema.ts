import type { DatabaseSync } from "node:sqlite";

export const JUDGMENT_SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE judgment_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE objective_profiles (objective_id TEXT NOT NULL, revision INTEGER NOT NULL, module_kind TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(objective_id, revision)) STRICT;
CREATE TABLE objective_profile_active (agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, module_kind TEXT NOT NULL, objective_id TEXT NOT NULL, revision INTEGER NOT NULL, activation_revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(agent_id, scope_id, module_kind), FOREIGN KEY(objective_id, revision) REFERENCES objective_profiles(objective_id, revision)) STRICT;
CREATE TABLE rounds (round_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, situation TEXT NOT NULL, sequence INTEGER NOT NULL, snapshot TEXT NOT NULL, snapshot_digest TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved','deferred','held')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(agent_id, scope_id, sequence)) STRICT;
CREATE TABLE candidate_sets (round_id TEXT PRIMARY KEY REFERENCES rounds(round_id), snapshot_digest TEXT NOT NULL, candidate_digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE assessments (round_id TEXT NOT NULL REFERENCES rounds(round_id), module_kind TEXT NOT NULL, snapshot_digest TEXT NOT NULL, input_digest TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(round_id, module_kind)) STRICT;
CREATE TABLE resolution_records (round_id TEXT PRIMARY KEY REFERENCES rounds(round_id), digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE selection_specs (round_id TEXT PRIMARY KEY REFERENCES rounds(round_id), spec_digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
CREATE TABLE intention_records (intention_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE TABLE intention_transitions (intention_id TEXT NOT NULL REFERENCES intention_records(intention_id), revision INTEGER NOT NULL, from_status TEXT NOT NULL, to_status TEXT NOT NULL, reason TEXT NOT NULL, evidence_ref TEXT, at TEXT NOT NULL, PRIMARY KEY(intention_id, revision)) STRICT;
`;

function verify(db: DatabaseSync): void {
	const expected = SCHEMA.split(";")
		.map((sql) => sql.trim())
		.filter(Boolean)
		.sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map(({ sql }) => sql)
		.sort();
	if (
		actual.length !== expected.length ||
		actual.some((sql, index) => sql !== expected[index])
	)
		throw Error("unknown judgment store schema");
}

export function initializeJudgmentSchema(
	db: DatabaseSync,
	fresh: boolean,
): void {
	const { user_version: version } =
		db.prepare("PRAGMA user_version").get() ?? {};
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version === 0 && tables.length === 0) {
		if (!fresh) throw Error("unknown judgment store schema");
		db.exec(SCHEMA);
		const insert = db.prepare(
			"INSERT INTO judgment_meta(key, value) VALUES (?, ?)",
		);
		insert.run("schema_version", String(JUDGMENT_SCHEMA_VERSION));
		insert.run("store", "judgment");
		db.exec(`PRAGMA user_version = ${JUDGMENT_SCHEMA_VERSION}`);
		return;
	}
	if (version !== JUDGMENT_SCHEMA_VERSION)
		throw Error("unknown judgment store schema");
	verify(db);
	const meta = db.prepare("SELECT value FROM judgment_meta WHERE key = ?");
	const { value: store } = meta.get("store") ?? {};
	const { value: schemaVersion } = meta.get("schema_version") ?? {};
	if (store !== "judgment" || schemaVersion !== "1")
		throw Error("unknown judgment store schema");
}
