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
import type { SourceEntry, SourcePolicy } from "./source-policy.ts";
import type {
	SourceExposure,
	SourceRequestOrigin,
} from "./source-policy-origin.ts";
import { SOURCE_SCHEMA } from "./source-policy-schema.ts";
import { SourcePolicyStore } from "./source-policy-store.ts";

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA = `
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
const SCHEMA = LEGACY_SCHEMA + SOURCE_SCHEMA;

function verifySchema(db: DatabaseSync, schema = SCHEMA): void {
	const normalize = (sql: string) => sql.trim().replace(/\s+/g, " ");
	const expected = schema.split(";").map(normalize).filter(Boolean).sort();
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
		if (version !== 1 && version !== SCHEMA_VERSION)
			throw new Error("unknown store schema");
		verifySchema(db, version === 1 ? LEGACY_SCHEMA : SCHEMA);
		const schema = db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get()?.["value"];
		if (schema !== String(version)) throw new Error("unknown store schema");
		const saved = db
			.prepare("SELECT value FROM meta WHERE key = 'binding'")
			.get()?.["value"];
		if (
			typeof saved !== "string" ||
			!isDeepStrictEqual(JSON.parse(saved), binding)
		)
			throw new Error("foreign store binding");
		if (version === 1) {
			validateJournalRows(db, binding.sessionId);
			db.exec(SOURCE_SCHEMA);
			db.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(
				String(SCHEMA_VERSION),
			);
			db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
		}
		verifySchema(db);
		validateJournalRows(db, binding.sessionId);
		new SourcePolicyStore(db, binding.sessionId).validate();
		return;
	}
	if (!fresh) throw new Error("unknown store schema");
	db.exec(SCHEMA);
	const insert = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
	insert.run("schema_version", String(SCHEMA_VERSION));
	insert.run("binding", JSON.stringify(binding));
	insert.run("revision", "0");
	db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	verifySchema(db);
	new SourcePolicyStore(db, binding.sessionId).validate();
}

function validateJournalRows(db: DatabaseSync, sessionId: string): void {
	if (
		db
			.prepare("PRAGMA quick_check")
			.all()
			.some((row) => row["quick_check"] !== "ok")
	)
		throw Error("Invalid journal source constraints");
	if (db.prepare("PRAGMA foreign_key_check").all().length)
		throw Error("Invalid journal source references");
	for (const row of db
		.prepare("SELECT seq,session_id,raw_json FROM entries")
		.all()) {
		if (
			row["session_id"] !== sessionId ||
			typeof row["seq"] !== "number" ||
			!Number.isSafeInteger(row["seq"]) ||
			row["seq"] < 1
		)
			throw Error("Invalid journal source row");
		try {
			JSON.parse(String(row["raw_json"]));
		} catch {
			throw Error("Invalid journal source JSON");
		}
	}
	if (
		db
			.prepare("SELECT 1 FROM requests WHERE session_id != ? LIMIT 1")
			.get(sessionId)
	)
		throw Error("Invalid journal source request owner");
}

function verifyCurrentJournal(db: DatabaseSync, binding: BotBinding): void {
	const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
	if (version !== SCHEMA_VERSION) {
		if (version === 1) throw new Error("journal migration required");
		throw new Error("unknown store schema");
	}
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
	validateJournalRows(db, binding.sessionId);
	new SourcePolicyStore(db, binding.sessionId).validate();
}

export class DurableStore {
	private readonly db: DatabaseSync;
	private readonly entries: Entries;
	private readonly journal: Requests;
	private readonly sources: SourcePolicyStore;
	private readonly readOnly: boolean;
	private closed = false;

	static openReadonly(path: string, binding: BotBinding): DurableStore {
		return new DurableStore(path, binding, { readOnly: true });
	}

	constructor(
		path: string,
		binding: BotBinding,
		options: { readOnly?: boolean } = {},
	) {
		const identity = validateBinding(binding);
		this.readOnly = options.readOnly === true;
		const opened = openCheckedDatabase(path, { readOnly: this.readOnly });
		this.db = opened.db;
		let transaction = false;
		try {
			this.db.exec(
				this.readOnly
					? "PRAGMA foreign_keys = ON; BEGIN"
					: "PRAGMA foreign_keys = ON; BEGIN IMMEDIATE",
			);
			transaction = true;
			if (this.readOnly) {
				if (opened.fresh) throw new Error("unknown store schema");
				verifyCurrentJournal(this.db, identity);
			} else initialize(this.db, identity, opened.fresh);
			this.db.exec("COMMIT");
			transaction = false;
			if (!this.readOnly)
				this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
			this.entries = new Entries(this.db, binding.sessionId);
			this.journal = new Requests(this.db, binding.sessionId);
			this.sources = new SourcePolicyStore(this.db, binding.sessionId);
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
	/** Model/memory consumers use this trusted association, never source fields in raw. */
	sourceEntry(entryId: string): (EntryInput & SourceEntry) | undefined {
		const entry = this.entries.entry(entryId);
		if (!entry) return;
		const requestId = this.sources.entryRequest(entryId);
		if (!requestId) return entry;
		const sourcePolicy = this.sources.policy(requestId),
			request = this.journal.request(requestId);
		if (!sourcePolicy || !request)
			throw Error("Missing journal source association");
		if (
			!request.entryId ||
			this.sources.userEntry(requestId) !== request.entryId
		)
			return { ...entry, requestStatus: request.status };
		return { ...entry, sourcePolicy, requestStatus: request.status };
	}
	requestSourcePolicy(requestId: string): SourcePolicy | undefined {
		return this.sources.policy(requestId);
	}
	/** Complete conversation membership, before any consumer applies eligibility or limits. */
	sourceEpisode(userEntryId: string): (EntryInput & SourceEntry)[] {
		this.db.exec("SAVEPOINT source_episode_read");
		try {
			const rows = this.db
				.prepare(`
				WITH origin AS (
					SELECT e.seq, s.request_id FROM entries e
					LEFT JOIN source_entries s ON s.entry_id = e.entry_id
					WHERE e.entry_id = ? AND e.role = 'user'
				), boundary AS (
					SELECT MIN(e.seq) AS next_seq FROM entries e, origin o
					WHERE e.seq > o.seq AND e.role = 'user'
				), members AS (
					SELECT e.seq, e.entry_id FROM entries e, origin o, boundary b
					WHERE e.seq >= o.seq AND (b.next_seq IS NULL OR e.seq < b.next_seq)
						AND e.role IN ('user', 'assistant')
					UNION
					SELECT e.seq, e.entry_id FROM origin o
					JOIN source_entries s ON s.request_id = o.request_id
					JOIN entries e ON e.entry_id = s.entry_id
					WHERE e.role IN ('user', 'assistant')
				)
				SELECT entry_id FROM members ORDER BY seq
			`)
				.all(userEntryId);
			const result = rows.map((row) => {
				const entry = this.sourceEntry(String(row["entry_id"]));
				if (!entry) throw Error("Missing journal episode member");
				return entry;
			});
			this.db.exec("RELEASE source_episode_read");
			return result;
		} catch (error) {
			this.db.exec(
				"ROLLBACK TO source_episode_read; RELEASE source_episode_read",
			);
			throw error;
		}
	}
	/** Trusted native transport sink. These methods are not model or HTTP operations. */
	recordSourceExposure(receipt: SourceExposure): boolean {
		return this.mutate(() => this.sources.exposure(receipt), Number);
	}
	registerRequestSource(origin: SourceRequestOrigin): boolean {
		return this.mutate(() => this.sources.register(origin), Number);
	}
	extendRequestSource(
		requestId: string,
		receiptIds: readonly string[],
	): boolean {
		return this.mutate(
			() => this.sources.extend(requestId, receiptIds),
			Number,
		);
	}
	appendSourceEntry(input: EntryInput, requestId: string): boolean {
		return this.mutate(() => {
			const appended = this.entries.append(input);
			const associated = this.sources.associate(input.entryId, requestId);
			const request = this.journal.request(requestId);
			const correlated =
				input.role === "user" &&
				request &&
				(request.status === "queued" || request.status === "accepted")
					? this.journal.set(requestId, request.status, {
							entryId: input.entryId,
						}).changed
					: false;
			return appended || associated || correlated;
		}, Number);
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
			() => {
				if (
					details.entryId !== undefined &&
					this.sources.policy(id) &&
					this.sources.userEntry(id) !== details.entryId
				)
					throw Error("Invalid source user correlation");
				return this.journal.set(id, status, details);
			},
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
		if (this.readOnly) throw new Error("readonly store mutation");
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
