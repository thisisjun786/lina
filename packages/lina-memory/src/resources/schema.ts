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
const expected = (() => {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(SCHEMA);
		return objects(db);
	} finally {
		db.close();
	}
})();
export function verifyResourceSchema(db: DatabaseSync): void {
	if (
		db.prepare("PRAGMA user_version").get()?.["user_version"] !== 1 ||
		!isDeepStrictEqual(objects(db), expected) ||
		db.prepare("PRAGMA foreign_key_check").all().length
	)
		throw Error("corrupt resource schema or references");
	if (
		db.prepare("SELECT key,value FROM resource_meta").all().length !== 1 ||
		db.prepare("SELECT value FROM resource_meta WHERE key='format'").get()?.[
			"value"
		] !== "lina-resources-v1"
	)
		throw Error("corrupt resource metadata");
}
export function initializeResources(db: DatabaseSync, fresh: boolean): void {
	if (fresh) {
		db.exec(SCHEMA);
		db.exec(
			"INSERT INTO resource_meta VALUES ('format','lina-resources-v1'); PRAGMA user_version=1",
		);
	}
	verifyResourceSchema(db);
}
