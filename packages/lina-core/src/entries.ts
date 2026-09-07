import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { CONVERSATION_FILTER } from "./conversation.ts";
import {
	type EntryInput,
	HISTORY_DEFAULT_LIMIT,
	HISTORY_MAX_LIMIT,
	type HistoryPage,
	PREVIEW_MAX_CHARS,
	type RequestStatus,
	type TimelineEntry,
} from "./protocol.ts";
import {
	projectToolMetadata,
	TOOL_METADATA_COLUMNS,
	type ToolMetadataRow,
	withToolMetadata,
} from "./tool-metadata.ts";

export const SEARCH_MAX_LIMIT = 20;
export const SEARCH_PREVIEW_MAX_CHARS = 512;
export const SEARCH_QUERY_MAX_CHARS = 512;
export const SCAN_MAX_LIMIT = 100;

export interface ScannedEntry {
	seq: number;
	entry: EntryInput;
	requestStatus?: RequestStatus;
}

interface EntryRow {
	entry_id: string;
	role: EntryInput["role"];
	text: string;
	timestamp: string;
	raw_json: string;
}

interface ScanRow extends EntryRow {
	seq: number;
	request_status: RequestStatus | null;
}

interface HistoryRow extends ToolMetadataRow {
	seq: number;
	entry_id: string;
	role: EntryInput["role"];
	preview: string;
	timestamp: string;
	truncated: number;
}

/** Escapes LIKE metacharacters so user text is matched literally. */
function literalPattern(query: string): string {
	return `%${query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class Entries {
	private readonly lookup;
	private readonly insert;
	private readonly page;
	private readonly conversationPage;
	private readonly find;
	private readonly findConversation;
	private readonly scan;

	constructor(
		db: DatabaseSync,
		private readonly sessionId: string,
	) {
		this.lookup = db.prepare(
			"SELECT entry_id, role, text, timestamp, raw_json FROM entries WHERE entry_id = ?",
		);
		this.insert = db.prepare(`INSERT INTO entries
			(entry_id, session_id, role, text, preview, truncated, raw_json, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
		this.page =
			db.prepare(`SELECT seq, entry_id, role, preview, timestamp, truncated,
			${TOOL_METADATA_COLUMNS}
			FROM entries WHERE role IN ('user','assistant','tool') AND seq < ?
			ORDER BY seq DESC LIMIT ?`);
		this.conversationPage =
			db.prepare(`SELECT seq, entry_id, role, preview, timestamp, truncated,
			${TOOL_METADATA_COLUMNS}
			FROM entries WHERE seq < ? AND (${CONVERSATION_FILTER})
			ORDER BY seq DESC LIMIT ?`);
		// LIKE is case-insensitive for ASCII only; instr() is exact. Both are literal.
		this.find =
			db.prepare(`SELECT seq, entry_id, role, text, timestamp, truncated,
			${TOOL_METADATA_COLUMNS}
			FROM entries WHERE role IN ('user','assistant','tool') AND seq < ?
			AND text LIKE ? ESCAPE '\\' AND instr(text, ?) > 0
			ORDER BY seq DESC LIMIT ?`);
		this.findConversation =
			db.prepare(`SELECT seq, entry_id, role, text, timestamp, truncated,
			${TOOL_METADATA_COLUMNS}
			FROM entries WHERE seq < ? AND (${CONVERSATION_FILTER})
			AND text LIKE ? ESCAPE '\\' AND instr(text, ?) > 0
			ORDER BY seq DESC LIMIT ?`);
		this.scan =
			db.prepare(`SELECT e.seq, e.entry_id, e.role, e.text, e.timestamp,
			e.raw_json, r.status AS request_status
			FROM entries e LEFT JOIN requests r ON r.entry_id = e.entry_id
			WHERE e.seq > ? ORDER BY e.seq ASC LIMIT ?`);
	}

	entry(id: string): EntryInput | undefined {
		// The schema and SELECT projection establish this raw SQLite row shape.
		const row = this.lookup.get(id) as EntryRow | undefined;
		if (!row) return undefined;
		return {
			entryId: row.entry_id,
			role: row.role,
			text: row.text,
			timestamp: row.timestamp,
			raw: JSON.parse(row.raw_json) as unknown,
		};
	}

	append(input: EntryInput): boolean {
		const raw = JSON.stringify(input.raw);
		if (raw === undefined) throw new Error("entry raw must be JSON");
		const existing = this.entry(input.entryId);
		if (existing) {
			if (
				!isDeepStrictEqual(existing, {
					...input,
					raw: JSON.parse(raw) as unknown,
				})
			)
				throw new Error("entry ID conflict");
			return false;
		}
		this.insert.run(
			input.entryId,
			this.sessionId,
			input.role,
			input.text,
			input.text.slice(0, PREVIEW_MAX_CHARS),
			Number(input.text.length > PREVIEW_MAX_CHARS),
			raw,
			input.timestamp,
		);
		return true;
	}

	history(options: { before?: number; limit?: number } = {}): HistoryPage {
		return this.readHistory(this.page, options);
	}

	conversationHistory(
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.readHistory(this.conversationPage, options);
	}

	private readHistory(
		query: StatementSync,
		{
			before = Number.MAX_SAFE_INTEGER,
			limit = HISTORY_DEFAULT_LIMIT,
		}: { before?: number; limit?: number },
	): HistoryPage {
		if (!Number.isSafeInteger(before) || before < 1)
			throw new Error("invalid history cursor");
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("invalid history limit");
		const size = Math.min(limit, HISTORY_MAX_LIMIT);
		const rows = query.all(before, size + 1) as unknown as HistoryRow[];
		const hasEarlier = rows.length > size;
		const messages: TimelineEntry[] = rows
			.slice(0, size)
			.reverse()
			.map((row) =>
				withToolMetadata(
					{
						seq: row.seq,
						entryId: row.entry_id,
						role: row.role,
						text: row.preview,
						timestamp: row.timestamp,
						truncated: row.truncated === 1,
					},
					projectToolMetadata(row.role, row),
				),
			);
		return { messages, hasEarlier, beforeCursor: messages[0]?.seq ?? null };
	}

	/** Literal substring search over visible text; no user SQL, wildcard or regex. */
	search(
		query: string,
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.searchWith(this.find, query, options);
	}
	conversationSearch(
		query: string,
		options: { before?: number; limit?: number } = {},
	): HistoryPage {
		return this.searchWith(this.findConversation, query, options);
	}
	private searchWith(
		statement: StatementSync,
		query: string,
		{
			before = Number.MAX_SAFE_INTEGER,
			limit = SEARCH_MAX_LIMIT,
		}: { before?: number; limit?: number } = {},
	): HistoryPage {
		if (typeof query !== "string" || query.trim().length === 0)
			throw new Error("search query must not be blank");
		if (query.length > SEARCH_QUERY_MAX_CHARS)
			throw new Error(
				`search query exceeds ${SEARCH_QUERY_MAX_CHARS} characters`,
			);
		if (!Number.isSafeInteger(before) || before < 1)
			throw new Error("invalid search cursor");
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("invalid search limit");
		const size = Math.min(limit, SEARCH_MAX_LIMIT);
		const rows = statement.all(
			before,
			literalPattern(query),
			query,
			size + 1,
		) as unknown as (Omit<HistoryRow, "preview"> & { text: string })[];
		const hasEarlier = rows.length > size;
		const messages: TimelineEntry[] = rows
			.slice(0, size)
			.reverse()
			.map((row) => {
				const at = Math.max(0, row.text.indexOf(query));
				const start = Math.max(
					0,
					Math.min(at - 64, row.text.length - SEARCH_PREVIEW_MAX_CHARS),
				);
				const preview = row.text.slice(start, start + SEARCH_PREVIEW_MAX_CHARS);
				return withToolMetadata(
					{
						seq: row.seq,
						entryId: row.entry_id,
						role: row.role,
						text: preview,
						timestamp: row.timestamp,
						truncated: preview.length < row.text.length,
					},
					projectToolMetadata(row.role, row),
				);
			});
		return { messages, hasEarlier, beforeCursor: messages[0]?.seq ?? null };
	}

	/** Forward scan of every committed entry after a cursor, joined to its request. */
	scanAfter(after: number, limit = SCAN_MAX_LIMIT): ScannedEntry[] {
		if (!Number.isSafeInteger(after) || after < 0)
			throw new Error("invalid scan cursor");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > SCAN_MAX_LIMIT)
			throw new Error(`invalid scan limit (1..${SCAN_MAX_LIMIT})`);
		const rows = this.scan.all(after, limit) as unknown as ScanRow[];
		return rows.map((row) => ({
			seq: row.seq,
			entry: {
				entryId: row.entry_id,
				role: row.role,
				text: row.text,
				timestamp: row.timestamp,
				raw: JSON.parse(row.raw_json) as unknown,
			},
			...(row.request_status === null
				? {}
				: { requestStatus: row.request_status }),
		}));
	}
}
