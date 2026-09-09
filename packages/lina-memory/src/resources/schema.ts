import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

const SCHEMA = `
CREATE TABLE resource_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE resources (id TEXT PRIMARY KEY,parent_id TEXT,owner_id TEXT NOT NULL,visibility TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE resource_versions (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),owner_id TEXT NOT NULL,visibility TEXT NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE resource_memberships (collection_id TEXT NOT NULL REFERENCES resources(id),resource_id TEXT NOT NULL REFERENCES resources(id),PRIMARY KEY(collection_id,resource_id)) STRICT;
CREATE TABLE resource_operations (id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,resource_id TEXT NOT NULL REFERENCES resources(id),revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,UNIQUE(resource_id,revision)) STRICT;
CREATE TABLE resource_jobs (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),source_digest TEXT NOT NULL,policy_revision INTEGER NOT NULL,model_settings_revision INTEGER NOT NULL,kind TEXT NOT NULL,generation_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(resource_id,source_digest,generation_key,kind)) STRICT;
CREATE TABLE resource_job_attempts (resource_id TEXT NOT NULL REFERENCES resources(id),source_digest TEXT NOT NULL,kind TEXT NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(resource_id,source_digest,kind)) STRICT;
CREATE TABLE resource_derivations (resource_id TEXT NOT NULL REFERENCES resources(id),source_digest TEXT NOT NULL,policy_revision INTEGER NOT NULL,model_settings_revision INTEGER NOT NULL,kind TEXT NOT NULL,generation_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(resource_id,source_digest,generation_key,kind)) STRICT;
CREATE VIRTUAL TABLE resource_fts USING fts5(resource_id UNINDEXED,source_digest UNINDEXED,text,tokenize='trigram');
`;
function objects(db: DatabaseSync): unknown[] {
	return db
		.prepare(
			"SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		.all()
		.map((r) => ({
			...r,
			sql:
				typeof r["sql"] === "string"
					? r["sql"].replace(/\s+/g, " ").trim()
					: r["sql"],
		}));
}
const MEMORY_SCHEMA = `
CREATE TABLE resource_memory_jobs (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),source_digest TEXT NOT NULL,kind TEXT NOT NULL,intent_revision INTEGER NOT NULL,generation_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(resource_id,source_digest,kind,intent_revision,generation_key)) STRICT;
CREATE TABLE resource_memory_attempts (resource_id TEXT NOT NULL REFERENCES resources(id),source_digest TEXT NOT NULL,kind TEXT NOT NULL,attempts INTEGER NOT NULL,PRIMARY KEY(resource_id,source_digest,kind)) STRICT;
CREATE TABLE resource_memory_intents (resource_id TEXT PRIMARY KEY REFERENCES resources(id),revision INTEGER NOT NULL,data TEXT NOT NULL) STRICT;
CREATE TABLE resource_memories (id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),version_id TEXT NOT NULL REFERENCES resource_versions(id),policy_revision INTEGER NOT NULL,proposer_id TEXT NOT NULL,visibility TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,evidence_json TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,UNIQUE(resource_id,version_id,policy_revision,fingerprint)) STRICT;
`;
const expected = (version: 1 | 2) => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(SCHEMA);
		if (version === 2) db.exec(MEMORY_SCHEMA);
		return objects(db);
	} finally {
		db.close();
	}
};
const expectedV1 = expected(1),
	expectedV2 = expected(2);
export function verifyResourceSchema(
	db: DatabaseSync,
	version: 1 | 2 = 2,
): void {
	if (
		db.prepare("PRAGMA user_version").get()?.["user_version"] !== version ||
		!isDeepStrictEqual(objects(db), version === 1 ? expectedV1 : expectedV2) ||
		db.prepare("PRAGMA foreign_key_check").all().length
	)
		throw Error("corrupt resource schema or references");
	if (
		db.prepare("SELECT key,value FROM resource_meta").all().length !== 1 ||
		db.prepare("SELECT value FROM resource_meta WHERE key='format'").get()?.[
			"value"
		] !== `lina-resources-v${version}`
	)
		throw Error("corrupt resource metadata");
}
export function initializeResources(db: DatabaseSync, fresh: boolean): void {
	if (fresh) {
		db.exec(SCHEMA + MEMORY_SCHEMA);
		db.exec(
			"INSERT INTO resource_meta VALUES ('format','lina-resources-v2'); PRAGMA user_version=2",
		);
	}
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	if (version !== 1 && version !== 2)
		throw Error("corrupt resource schema version");
	verifyResourceSchema(db, version);
}
/** Called only after legacy resource and indexing audits, inside opening transaction. */
export function migrateResources(db: DatabaseSync): void {
	if (!db.isTransaction) throw Error("resource migration requires transaction");
	if (db.prepare("PRAGMA user_version").get()?.["user_version"] === 1) {
		db.exec(MEMORY_SCHEMA);
		db.exec(
			"UPDATE resource_meta SET value='lina-resources-v2' WHERE key='format'; PRAGMA user_version=2",
		);
	}
	verifyResourceSchema(db);
}
