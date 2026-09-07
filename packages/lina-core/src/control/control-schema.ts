import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { BotBinding } from "../protocol.ts";
import { verifyControlRecords } from "./control-records.ts";

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE tools (
	id TEXT PRIMARY KEY, nativeCallId TEXT NOT NULL, requestId TEXT NOT NULL, name TEXT NOT NULL,
	state TEXT NOT NULL CHECK(state IN ('preparing','waiting_approval','ready','running','succeeded','failed','blocked','interrupted')),
	inputPreview TEXT NOT NULL, outputPreview TEXT NOT NULL,
	createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
) STRICT;
CREATE TABLE approvals (
	id TEXT PRIMARY KEY, toolRunId TEXT NOT NULL UNIQUE REFERENCES tools(id),
	inputDigest TEXT NOT NULL, inputJson TEXT NOT NULL,
	state TEXT NOT NULL CHECK(state IN ('pending','allowed','denied','expired','aborted')),
	expiresAt INTEGER NOT NULL, createdAt TEXT NOT NULL, decidedRevision INTEGER
) STRICT;
CREATE INDEX pending_approvals ON approvals(state) WHERE state = 'pending';
`;

export function readRevision(db: DatabaseSync): number {
	const value = db
		.prepare("SELECT value FROM meta WHERE key = 'revision'")
		.get()?.["value"];
	if (
		typeof value !== "string" ||
		!/^(0|[1-9]\d*)$/.test(value) ||
		!Number.isSafeInteger(Number(value))
	)
		throw new Error("invalid control revision");
	return Number(value);
}

export function initializeControl(
	db: DatabaseSync,
	binding: BotBinding,
	fresh: boolean,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const rows = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (fresh && version === 0 && rows.length === 0) {
		db.exec(SCHEMA);
		const insert = db.prepare("INSERT INTO meta VALUES (?, ?)");
		insert.run("schema_version", String(SCHEMA_VERSION));
		insert.run("binding", JSON.stringify(binding));
		insert.run("revision", "0");
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		return;
	}
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const expected = SCHEMA.split(";").map(normalize).filter(Boolean).sort();
	const actual = rows.map((row) => normalize(String(row["sql"]))).sort();
	if (version !== SCHEMA_VERSION || !isDeepStrictEqual(actual, expected))
		throw new Error("unknown control schema");
	const meta = db.prepare("SELECT key, value FROM meta ORDER BY key").all();
	if (
		!isDeepStrictEqual(
			meta.map((row) => row["key"]),
			["binding", "revision", "schema_version"],
		) ||
		meta[2]?.["value"] !== String(SCHEMA_VERSION)
	)
		throw new Error("unknown control schema metadata");
	const saved = meta[0]?.["value"];
	if (
		typeof saved !== "string" ||
		!isDeepStrictEqual(JSON.parse(saved), binding)
	)
		throw new Error("foreign control binding");
	const revision = readRevision(db);
	if (
		db.prepare("PRAGMA quick_check").get()?.["quick_check"] !== "ok" ||
		db.prepare("PRAGMA foreign_key_check").all().length > 0
	)
		throw new Error("corrupt control store");
	verifyControlRecords(db, revision);
}
