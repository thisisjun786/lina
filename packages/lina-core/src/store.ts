import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { CONVERSATION_FILTER } from "./conversation.ts";
import { Entries, type ScannedEntry } from "./entries.ts";
import type {
	BotBinding,
	EntryInput,
	HistoryPage,
	RequestRecord,
	RequestStatus,
} from "./protocol.ts";
import { type RequestDetails, Requests } from "./requests.ts";
import { openCheckedDatabase, validateBinding } from "./session-binding.ts";

const SCHEMA_VERSION = 1;
const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE entries (
	seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL UNIQUE,
	session_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','meta')),
	text TEXT NOT NULL, preview TEXT NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
	raw_json TEXT NOT NULL, timestamp TEXT NOT NULL
) STRICT;
CREATE INDEX visible_entries ON entries(seq) WHERE role IN ('user','assistant','tool');
CREATE TABLE requests (
	id TEXT PRIMARY KEY, session_id TEXT NOT NULL, text TEXT NOT NULL,
	status TEXT NOT NULL CHECK(status IN ('queued','accepted','settled','rejected','interrupted')),
	created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
	entry_id TEXT REFERENCES entries(entry_id)
) STRICT;
CREATE INDEX pending_requests ON requests(status) WHERE status IN ('queued','accepted');
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
		throw new Error("unknown store schema");
	const revision = db
		.prepare("SELECT value FROM meta WHERE key = 'revision'")
		.get()?.["value"];
	if (
		typeof revision !== "string" ||
		!/^(0|[1-9]\d*)$/.test(revision) ||
		!Number.isSafeInteger(Number(revision))
	)
		throw new Error("invalid store revision");
}

function initialize(
	db: DatabaseSync,
	binding: BotBinding,
	fresh: boolean,
): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	const tables = db
		.prepare("SELECT name FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
		.all();
	if (version !== 0 || tables.length > 0) {
		if (version !== SCHEMA_VERSION) throw new Error("unknown store schema");
		verifySchema(db);
		const schema = db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get()?.["value"];
		if (schema !== String(SCHEMA_VERSION))
			throw new Error("unknown store schema");
		const saved = db
			.prepare("SELECT value FROM meta WHERE key = 'binding'")
			.get()?.["value"];
		if (
			typeof saved !== "string" ||
			!isDeepStrictEqual(JSON.parse(saved), binding)
		)
			throw new Error("foreign store binding");
		return;
	}
	if (!fresh) throw new Error("unknown store schema");
	db.exec(SCHEMA);
	const insert = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
	insert.run("schema_version", String(SCHEMA_VERSION));
	insert.run("binding", JSON.stringify(binding));
	insert.run("revision", "0");
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export class DurableStore {
	private readonly db: DatabaseSync;
	private readonly entries: Entries;
	private readonly journal: Requests;
	private closed = false;

	constructor(path: string, binding: BotBinding) {
		const identity = validateBinding(binding);
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		let transaction = false;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			transaction = true;
			initialize(this.db, identity, opened.fresh);
			this.db.exec("COMMIT");
			transaction = false;
			this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
			this.entries = new Entries(this.db, binding.sessionId);
			this.journal = new Requests(this.db, binding.sessionId);
		} catch (error) {
			if (transaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	appendEntry(input: EntryInput): boolean {
		return this.mutate(() => this.entries.append(input), Number);
	}

	entry(entryId: string): EntryInput | undefined {
		return this.entries.entry(entryId);
	}
	entrySequence(entryId: string): number | undefined {
		const seq = this.db
			.prepare("SELECT seq FROM entries WHERE entry_id=?")
			.get(entryId)?.["seq"];
		return typeof seq === "number" ? seq : undefined;
	}
	history(options: { before?: number; limit?: number } = {}): HistoryPage {
		return this.entries.history(options);
	}
	/** Bounded human presentation; raw history, search and entry remain available. */
	conversationHistory(
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.entries.conversationHistory(options);
	}
	/** A durable reply, independent of pagination and the current incoming user entry. */
	hasNormalAssistantReply(): boolean {
		return !!this.db
			.prepare(`SELECT 1 FROM entries WHERE role = 'assistant'
		 AND (${CONVERSATION_FILTER})
		 AND CASE WHEN json_valid(raw_json) THEN
		  json_extract(raw_json, '$.type') IS NOT 'custom_message'
		  AND coalesce(json_extract(raw_json, '$.message.stopReason'), '') NOT IN ('error','aborted')
		 ELSE 1 END LIMIT 1`)
			.get();
	}
	conversationSearch(
		query: string,
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.entries.conversationSearch(query, options);
	}

	search(
		query: string,
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.entries.search(query, options);
	}
	/** Internal forward scan for runtime settlement; never sent to the browser. */
	scanAfter(after: number, limit?: number): ScannedEntry[] {
		return this.entries.scanAfter(after, limit);
	}
	request(id: string): RequestRecord | undefined {
		return this.journal.request(id);
	}
	requestByEntry(entryId: string): RequestRecord | undefined {
		if (typeof entryId !== "string" || entryId.length === 0) return undefined;
		const row = this.db
			.prepare(
				"SELECT id FROM requests WHERE entry_id = ? ORDER BY rowid LIMIT 1",
			)
			.get(entryId);
		return typeof row?.["id"] === "string"
			? this.journal.request(row["id"])
			: undefined;
	}
	requests(limit = 20): RequestRecord[] {
		return this.journal.requests(limit);
	}

	createRequest(
		id: string,
		text: string,
	): { request: RequestRecord; created: boolean } {
		return this.mutate(
			() => this.journal.create(id, text),
			(result) => Number(result.created),
		);
	}

	setRequest(
		id: string,
		status: RequestStatus,
		details: RequestDetails = {},
	): RequestRecord {
		return this.mutate(
			() => this.journal.set(id, status, details),
			(result) => Number(result.changed),
		).request;
	}

	recover(): number {
		return this.mutate(
			() => this.journal.recover(),
			(count) => count,
		);
	}

	revision(): number {
		return Number(
			this.db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()?.[
				"value"
			],
		);
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private mutate<T>(action: () => T, changes: (result: T) => number): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			const count = changes(result);
			if (count)
				this.db
					.prepare(
						"UPDATE meta SET value = CAST(CAST(value AS INTEGER) + ? AS INTEGER) WHERE key = 'revision'",
					)
					.run(count);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
