import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parsePartKey } from "./messages.ts";
import type { BotBinding, HonchoIdentity, OrdinaryNamespace } from "./types.ts";

const LEGACY_SCHEMA = `
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
const SCHEMA =
	LEGACY_SCHEMA.replace(
		"'unknown','failed'",
		"'unknown','failed','withheld'",
	).replace(
		"remote_id TEXT, error TEXT,",
		"remote_id TEXT, error TEXT, key_json TEXT, withheld_reason TEXT,",
	) +
	`
CREATE TABLE delivery_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, part_id INTEGER NOT NULL REFERENCES parts(id),
 from_state TEXT NOT NULL, to_state TEXT NOT NULL, remote_id TEXT, error TEXT, reason TEXT
) STRICT;
`;
export type OutboxOwner = {
	binding: BotBinding;
	identity: HonchoIdentity;
	ordinaryNamespace?: OrdinaryNamespace;
};

function verifySchema(db: DatabaseSync, schema: string): void {
	const normalize = (sql: string) =>
		sql
			.trim()
			.replace(/\s+/g, " ")
			.replace(/"parts"/g, "parts");
	const expected = schema.split(";").map(normalize).filter(Boolean).sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((row) => normalize(String(row["sql"])))
		.sort();
	if (!isDeepStrictEqual(actual, expected))
		throw new Error("unknown outbox schema");
}

function validateRows(
	db: DatabaseSync,
	owner: OutboxOwner,
	legacy = false,
): void {
	const meta = db.prepare("SELECT key, value FROM meta").all();
	if (
		meta.length !== 1 ||
		meta[0]?.["key"] !== "owner" ||
		typeof meta[0]["value"] !== "string" ||
		!isDeepStrictEqual(JSON.parse(meta[0]["value"]), owner)
	)
		throw new Error("foreign outbox owner");
	const scans = db.prepare("SELECT id, after, eligible_user FROM scan").all();
	if (
		scans.length !== 1 ||
		scans[0]?.["id"] !== 1 ||
		!Number.isSafeInteger(scans[0]["after"]) ||
		Number(scans[0]["after"]) < 0 ||
		![0, 1].includes(Number(scans[0]["eligible_user"]))
	)
		throw new Error("invalid outbox scan state");
	for (const row of db.prepare("SELECT * FROM parts").all()) {
		if (
			!Number.isSafeInteger(row["id"]) ||
			Number(row["id"]) < 1 ||
			typeof row["entry_id"] !== "string" ||
			!row["entry_id"] ||
			!Number.isSafeInteger(row["part_index"]) ||
			Number(row["part_index"]) < 0 ||
			!/^[a-f0-9]{64}$/.test(String(row["content_hash"]))
		)
			throw new Error("invalid outbox part row");
		if (!legacy) {
			if (row["key_json"] !== null) {
				if (typeof row["key_json"] !== "string")
					throw new Error("invalid outbox provenance");
				const key = parsePartKey(JSON.parse(row["key_json"]));
				if (
					key.version !== 2 ||
					key.entryId !== row["entry_id"] ||
					key.partIndex !== row["part_index"] ||
					key.contentHash !== row["content_hash"] ||
					!isDeepStrictEqual(key.policyScope, owner.ordinaryNamespace)
				)
					throw new Error("invalid outbox provenance owner");
			} else if (row["state"] !== "withheld")
				throw new Error("unqualified outbox part not withheld");
			if (
				(row["state"] === "withheld") !==
				(typeof row["withheld_reason"] === "string" &&
					row["withheld_reason"].length > 0)
			)
				throw new Error("invalid outbox withheld reason");
		}
	}
	if (
		!legacy &&
		db
			.prepare(
				"SELECT id FROM delivery_history WHERE part_id NOT IN (SELECT id FROM parts)",
			)
			.get()
	)
		throw new Error("invalid outbox delivery history");
}

export function initializeOutbox(
	db: DatabaseSync,
	owner: OutboxOwner,
	fresh: boolean,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version === 0 && tables.length === 0 && fresh) {
		db.exec(SCHEMA);
		db.prepare("INSERT INTO meta VALUES ('owner', ?)").run(
			JSON.stringify(owner),
		);
		db.exec("INSERT INTO scan VALUES (1, 0, 0)");
	} else if (version === 1) {
		verifySchema(db, LEGACY_SCHEMA);
		validateRows(db, owner, true);
		// Keep IDs, scan cursor, content, remote receipts and attempt errors. Migration
		// records the original state before withholding every unclassified legacy row.
		db.exec("ALTER TABLE parts RENAME TO old_parts; DROP INDEX open_parts");
		const partsSchema = SCHEMA.split(";")
			.filter((sql) =>
				/CREATE TABLE parts|CREATE INDEX open_parts|CREATE TABLE delivery_history/.test(
					sql,
				),
			)
			.join(";");
		db.exec(partsSchema);
		db.exec(`INSERT INTO parts(id,entry_id,part_index,role,content,content_hash,state,remote_id,error,key_json,withheld_reason)
 SELECT id,entry_id,part_index,role,content,content_hash,'withheld',remote_id,error,NULL,'legacy_unclassified' FROM old_parts;
 INSERT INTO delivery_history(part_id,from_state,to_state,remote_id,error,reason)
 SELECT id,state,'withheld',remote_id,error,'legacy_unclassified' FROM old_parts;
 DROP TABLE old_parts;`);
	} else if (version !== 2) throw new Error("unknown outbox schema");
	verifySchema(db, SCHEMA);
	validateRows(db, owner);
	db.exec(`INSERT INTO delivery_history(part_id,from_state,to_state,remote_id,error,reason)
 SELECT id,state,'unknown',remote_id,error,'interrupted while sending' FROM parts WHERE state = 'sending';
 UPDATE parts SET state = 'unknown', error = 'interrupted while sending' WHERE state = 'sending';`);
	validateRows(db, owner);
	db.exec("PRAGMA user_version = 2");
}
