import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parseProofs } from "../../../lina-memory/src/engine/validation.ts";

const SCHEMA = `
CREATE TABLE companion_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor>=0), user_id TEXT, assistant_id TEXT) STRICT;
CREATE TABLE companion_jobs (id TEXT PRIMARY KEY, sources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')), attempts INTEGER NOT NULL CHECK(attempts>=0), retry_at INTEGER NOT NULL CHECK(retry_at>=0), error TEXT) STRICT;
CREATE INDEX companion_ready ON companion_jobs(state,retry_at);`;
const EXTRA_SCHEMA = `
CREATE TABLE companion_job_meta (id TEXT PRIMARY KEY REFERENCES companion_jobs(id), allowance INTEGER NOT NULL, outcome TEXT, reset_revision INTEGER) STRICT;
CREATE TABLE companion_history (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, event TEXT NOT NULL, attempt INTEGER NOT NULL, at INTEGER NOT NULL, error TEXT) STRICT;`;

const JOB_SCHEMA = `CREATE TABLE "companion_jobs" (id TEXT PRIMARY KEY, sources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed','withheld')), attempts INTEGER NOT NULL CHECK(attempts>=0), retry_at INTEGER NOT NULL CHECK(retry_at>=0), error TEXT, source_proofs TEXT, withheld_reason TEXT) STRICT;`;
const CURRENT_SCHEMA =
	SCHEMA.slice(0, SCHEMA.indexOf("CREATE TABLE companion_jobs")) +
	JOB_SCHEMA +
	"CREATE INDEX companion_ready ON companion_jobs(state,retry_at);" +
	EXTRA_SCHEMA;
function schema(db: DatabaseSync, version: number): void {
	const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
	const expected = (
		version === 4
			? CURRENT_SCHEMA
			: SCHEMA + (version === 3 ? EXTRA_SCHEMA : "")
	)
		.split(";")
		.map(normalize)
		.filter(Boolean)
		.sort();
	const actual = db
		.prepare("SELECT sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all()
		.map((r) => normalize(String(r["sql"])))
		.sort();
	if (![2, 3, 4].includes(version) || !isDeepStrictEqual(expected, actual))
		throw Error(
			"Unknown companion queue schema; legacy jobs require explicit migration",
		);
}
function validateRows(db: DatabaseSync, version: number): void {
	const meta = db
		.prepare("SELECT cursor,user_id,assistant_id FROM companion_meta")
		.all();
	if (meta.length !== 1) throw Error("Invalid companion metadata");
	const id = (value: unknown) =>
		typeof value === "string" && value.trim().length > 0 && value.length <= 256;
	const number = (value: unknown) =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	if (
		!number(meta[0]?.["cursor"]) ||
		["user_id", "assistant_id"].some(
			(k) => meta[0]?.[k] !== null && !id(meta[0]?.[k]),
		)
	)
		throw Error("Invalid companion scan state");
	for (const row of db.prepare("SELECT * FROM companion_jobs").iterate()) {
		const sources: unknown = JSON.parse(String(row["sources"]));
		if (
			!id(row["id"]) ||
			!Array.isArray(sources) ||
			!sources.length ||
			sources.length > 50 ||
			sources.some((s) => !id(s)) ||
			new Set(sources).size !== sources.length ||
			sources[0] !== row["id"] ||
			!number(row["attempts"]) ||
			!number(row["retry_at"]) ||
			(row["error"] !== null && typeof row["error"] !== "string")
		)
			throw Error("Invalid companion job data");
		if (version === 4) {
			const proof =
				row["source_proofs"] === null
					? undefined
					: parseProofs(JSON.parse(String(row["source_proofs"])));
			if (
				proof &&
				(proof.length !== sources.length ||
					sources.some((id) => !proof.some((p) => p.entryId === id)))
			)
				throw Error("Invalid companion episode proof");
			if (
				(row["state"] === "withheld") !==
				(typeof row["withheld_reason"] === "string" &&
					row["withheld_reason"].length > 0)
			)
				throw Error("Invalid companion withholding");
		}
	}
	if (version >= 3) {
		if (
			db
				.prepare(
					"SELECT 1 FROM companion_jobs j LEFT JOIN companion_job_meta m ON m.id=j.id WHERE m.id IS NULL",
				)
				.get() ||
			db
				.prepare(
					"SELECT 1 FROM companion_job_meta m LEFT JOIN companion_jobs j ON j.id=m.id WHERE j.id IS NULL",
				)
				.get()
		)
			throw Error("Invalid companion job metadata");
		for (const r of db
			.prepare(
				"SELECT allowance,outcome,reset_revision FROM companion_job_meta",
			)
			.iterate())
			if (
				!number(r["allowance"]) ||
				(r["outcome"] !== null &&
					!["done", "changed", "unchanged"].includes(String(r["outcome"]))) ||
				(r["reset_revision"] !== null && !number(r["reset_revision"]))
			)
				throw Error("Invalid companion attempt metadata");
		for (const r of db
			.prepare("SELECT id,event,attempt,at,error FROM companion_history")
			.iterate())
			if (
				!id(r["id"]) ||
				![
					"legacy",
					"start",
					"done",
					"changed",
					"unchanged",
					"failed",
					"recovery",
					"withheld",
				].includes(String(r["event"])) ||
				!number(r["attempt"]) ||
				!number(r["at"]) ||
				(r["error"] !== null && typeof r["error"] !== "string")
			)
				throw Error("Invalid companion history");
	}
}
export function initializeCompanion(
	db: DatabaseSync,
	fresh: boolean,
	binding: unknown,
): void {
	if (fresh) {
		db.exec(CURRENT_SCHEMA);
		db.prepare("INSERT INTO companion_meta VALUES(1,?,0,NULL,NULL)").run(
			JSON.stringify(binding),
		);
		db.exec("PRAGMA user_version=4");
	}
	const version = Number(
		db.prepare("PRAGMA user_version").get()?.["user_version"],
	);
	schema(db, version);
	const saved = db
		.prepare("SELECT binding FROM companion_meta WHERE id=1")
		.get()?.["binding"];
	if (
		typeof saved !== "string" ||
		!isDeepStrictEqual(JSON.parse(saved), binding)
	)
		throw Error("Foreign companion queue binding");
	validateRows(db, version);
	if (version === 2) {
		db.exec(EXTRA_SCHEMA);
		db.exec(
			"INSERT INTO companion_job_meta SELECT id,3,NULL,NULL FROM companion_jobs; INSERT INTO companion_history(id,event,attempt,at,error) SELECT id,'legacy',attempts,0,error FROM companion_jobs;",
		);
	}
	if (version < 4) {
		const metadata = db
			.prepare(
				"SELECT id,allowance,outcome,reset_revision FROM companion_job_meta",
			)
			.all();
		db.exec("DROP TABLE companion_job_meta;");
		db.exec(JOB_SCHEMA.replace('"companion_jobs"', '"companion_jobs_new"'));
		db.exec(
			"INSERT INTO companion_jobs_new SELECT id,sources,state,attempts,retry_at,error,NULL,NULL FROM companion_jobs; DROP TABLE companion_jobs; ALTER TABLE companion_jobs_new RENAME TO companion_jobs; CREATE INDEX companion_ready ON companion_jobs(state,retry_at); PRAGMA user_version=4;",
		);
		db.exec(
			EXTRA_SCHEMA.slice(
				0,
				EXTRA_SCHEMA.indexOf("CREATE TABLE companion_history"),
			),
		);
		for (const row of metadata)
			db.prepare("INSERT INTO companion_job_meta VALUES (?,?,?,?)").run(
				String(row["id"]),
				Number(row["allowance"]),
				row["outcome"] === null ? null : String(row["outcome"]),
				row["reset_revision"] === null ? null : Number(row["reset_revision"]),
			);
	}
	schema(db, 4);
	validateRows(db, 4);
	if (db.prepare("PRAGMA foreign_key_check").get())
		throw Error("Invalid companion foreign key");
}
