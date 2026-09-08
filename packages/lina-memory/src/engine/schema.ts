import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import { auditEngineData } from "./audit.ts";
import { CONSOLIDATION_SCHEMA, ConsolidationQueue } from "./consolidation.ts";
import { parseRecord, revisionSchema } from "./validation.ts";

const SCHEMA = `
CREATE TABLE engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE engine_records (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','resolved','retracted')), expires_at INTEGER, updated_at INTEGER NOT NULL, data TEXT NOT NULL) STRICT;
CREATE INDEX engine_active ON engine_records(status, updated_at, id);
CREATE TABLE engine_sources (record_id TEXT NOT NULL REFERENCES engine_records(id), entry_id TEXT NOT NULL, quote TEXT NOT NULL, PRIMARY KEY(record_id, entry_id, quote)) STRICT;
CREATE INDEX engine_source_entry ON engine_sources(entry_id, record_id);
CREATE TABLE engine_fences (entry_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision > 0)) STRICT;
CREATE TABLE engine_receipts (request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0)) STRICT;
CREATE TABLE engine_observations (request_id TEXT NOT NULL REFERENCES engine_receipts(request_id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(request_id, ordinal)) STRICT;
`;
const SLOT_SCHEMA =
	"CREATE TABLE engine_slot_fences (record_id TEXT NOT NULL, entry_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), PRIMARY KEY(record_id,entry_id)) STRICT;";
const PROOF_SCHEMA = `
CREATE TABLE engine_request_sources (request_id TEXT PRIMARY KEY REFERENCES engine_receipts(request_id), source_proofs TEXT NOT NULL, input_source_proofs TEXT NOT NULL) STRICT;
CREATE TABLE engine_record_history (id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,revision)) STRICT;
`;
const REASONING_SCHEMA = `${CONSOLIDATION_SCHEMA}
CREATE TABLE engine_reasoning_checkpoint (id INTEGER PRIMARY KEY CHECK(id=1), dirty_revision INTEGER NOT NULL) STRICT;
CREATE TABLE engine_reasoning_receipts (request_id TEXT PRIMARY KEY REFERENCES engine_reasoning_jobs(id), fingerprint TEXT NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('changed','unchanged'))) STRICT;
CREATE TABLE engine_premises (conclusion_id TEXT NOT NULL, conclusion_revision INTEGER NOT NULL, premise_id TEXT NOT NULL, premise_revision INTEGER NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(conclusion_id,conclusion_revision,premise_id), FOREIGN KEY(conclusion_id,conclusion_revision) REFERENCES engine_record_history(id,revision), FOREIGN KEY(premise_id,premise_revision) REFERENCES engine_record_history(id,revision)) STRICT;
`;
export function initializeEngine(
	db: DatabaseSync,
	binding: BotBinding,
	fresh: boolean,
): void {
	if (fresh) {
		db.exec(SCHEMA + SLOT_SCHEMA + PROOF_SCHEMA);
		const insert = db.prepare("INSERT INTO engine_meta VALUES (?, ?)");
		insert.run("binding", JSON.stringify(binding));
		insert.run("revision", "0");
		db.exec("PRAGMA user_version = 3");
		initializeEngine(db, binding, false);
		return;
	}
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => normalize(String(row["sql"])))
		.sort();
	if (
		(version !== 1 && version !== 2 && version !== 3 && version !== 4) ||
		!isDeepStrictEqual(
			actual,
			(
				SCHEMA +
				(version !== 1 ? SLOT_SCHEMA : "") +
				(Number(version) >= 3 ? PROOF_SCHEMA : "") +
				(version === 4 ? REASONING_SCHEMA : "")
			)
				.split(";")
				.map(normalize)
				.filter(Boolean)
				.sort(),
		)
	)
		throw new Error("unknown engine schema");
	const saved = db
		.prepare("SELECT value FROM engine_meta WHERE key = 'binding'")
		.get()?.["value"];
	if (
		typeof saved !== "string" ||
		!isDeepStrictEqual(JSON.parse(saved), binding)
	)
		throw new Error("foreign engine binding");
	const revision = db
		.prepare("SELECT value FROM engine_meta WHERE key = 'revision'")
		.get()?.["value"];
	if (typeof revision !== "string") throw new Error("missing engine revision");
	const current = revisionSchema.parse(JSON.parse(revision));
	// Stream the disk boundary audit; public reads are separately capped in SQL.
	for (const row of db
		.prepare(
			"SELECT id, agent_id, status, expires_at, updated_at, data FROM engine_records",
		)
		.iterate()) {
		if (typeof row["data"] !== "string")
			throw new Error("invalid engine record");
		const record = parseRecord(JSON.parse(row["data"]));
		if (
			record.agentId !== binding.botId ||
			record.id !== row["id"] ||
			row["agent_id"] !== record.agentId ||
			row["status"] !== record.status ||
			row["expires_at"] !== record.expiresAt ||
			row["updated_at"] !== record.updatedAt ||
			record.revision > current
		)
			throw new Error("invalid engine record binding or projection");
	}
	auditEngineData(db, current, Number(version), binding.botId);
	if (Number(version) < 3) {
		if (version === 1) db.exec(SLOT_SCHEMA);
		db.exec(PROOF_SCHEMA + "PRAGMA user_version=3;");
		initializeEngine(db, binding, false);
	} else if (version === 3) {
		db.exec(REASONING_SCHEMA);
		db.prepare(
			"INSERT INTO engine_meta VALUES ('reasoning_migration_revision',?)",
		).run(String(current));
		db.prepare("INSERT INTO engine_reasoning_checkpoint VALUES (1,?)").run(
			current,
		);
		db.exec("PRAGMA user_version=4;");
		initializeEngine(db, binding, false);
	} else {
		const migration = db
			.prepare(
				"SELECT value FROM engine_meta WHERE key='reasoning_migration_revision'",
			)
			.get()?.["value"];
		if (
			typeof migration !== "string" ||
			revisionSchema.parse(JSON.parse(migration)) > current
		)
			throw Error("invalid reasoning migration revision");
		const checkpoints = db
			.prepare("SELECT id,dirty_revision FROM engine_reasoning_checkpoint")
			.all();
		if (
			checkpoints.length !== 1 ||
			checkpoints[0]?.["id"] !== 1 ||
			revisionSchema.parse(checkpoints[0]?.["dirty_revision"]) > current
		)
			throw Error("invalid reasoning checkpoint");
		new ConsolidationQueue(db);
	}
	if (db.prepare("PRAGMA foreign_key_check").get())
		throw new Error("invalid engine foreign key");
}
