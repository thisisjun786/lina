import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { boundedId, validateAgentInput } from "../agents/validation.ts";
import { openCheckedDatabase } from "../session-binding.ts";
import {
	type CreateDialogueInput,
	type DialogueData,
	type DialogueKind,
	type DialoguePatch,
	type DialogueStatus,
	type DialogueTurnStatus,
	MAX_DIALOGUE_ERROR,
	MAX_FINALIZATION_BYTES,
	MAX_NON_DONE_ROOMS,
	MAX_NON_OPENING_TURNS,
	MAX_SUMMARY_ITEM,
	MAX_SUMMARY_ITEMS,
	MAX_TRANSCRIPT_BYTES,
	MAX_TURN_REPLY,
	MAX_TURN_TEXT,
	type Room,
	type Turn,
} from "./dialogue-types.ts";
import {
	field,
	fields,
	newUuid,
	object,
	optionalText,
	parseInterviewMode,
	requireRevision,
	requireUuid,
} from "./helpers.ts";
import {
	CHAPTER_IDS,
	type ChapterId,
	type InterviewMode,
	MAX_CHAPTER_TEXT,
	MAX_USER_ANSWER,
	USER_ANSWER_KEYS,
	type UserAnswers,
} from "./types.ts";
import { parseUserSkipped } from "./user-basics.ts";

const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS dialogue_rooms (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('user','persona')), status TEXT NOT NULL CHECK (status IN ('active','applying','choices','done')), revision INTEGER NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('fast','thoughtful')), draft_id TEXT, data_json TEXT NOT NULL, created_at INTEGER NOT NULL, finalization_json TEXT) STRICT",
	"CREATE TABLE IF NOT EXISTS dialogue_turns (id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES dialogue_rooms(id), request_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT, reply TEXT, status TEXT NOT NULL CHECK (status IN ('pending','done','failed')), attempts INTEGER NOT NULL, error TEXT, summary_json TEXT NOT NULL, created_at INTEGER NOT NULL, replied_at INTEGER, UNIQUE (room_id, request_id), UNIQUE (room_id, seq)) STRICT",
	"CREATE TABLE IF NOT EXISTS dialogue_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES dialogue_rooms(id), turn_id TEXT NOT NULL REFERENCES dialogue_turns(id), request_id TEXT NOT NULL, event TEXT NOT NULL CHECK (event IN ('begin','retry','fail','recover')), error TEXT, created_at INTEGER NOT NULL) STRICT",
].join(";");

const STATUS_NEXT: Record<DialogueStatus, readonly DialogueStatus[]> = {
	active: ["applying", "choices", "done"],
	applying: ["choices", "done"],
	choices: ["applying", "done"],
	done: [],
};

type RoomRow = {
	id: string;
	agent_id: string;
	kind: string;
	status: string;
	revision: number;
	mode: string;
	draft_id: string | null;
	data_json: string;
	created_at: number;
	finalization_json: string | null;
};

type TurnRow = {
	id: string;
	room_id: string;
	request_id: string;
	seq: number;
	text: string | null;
	reply: string | null;
	status: string;
	attempts: number;
	error: string | null;
	summary_json: string;
	created_at: number;
	replied_at: number | null;
};

function clone<T>(value: T): T {
	return structuredClone(value);
}

function json<T>(value: string, label: string): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new Error(`corrupt ${label}`);
	}
}

function utf8(value: string | null): number {
	return value ? Buffer.byteLength(value, "utf8") : 0;
}

function parseKind(value: unknown): DialogueKind {
	if (value !== "user" && value !== "persona") throw new Error("invalid kind");
	return value;
}

function parseStatus(value: unknown): DialogueStatus {
	if (
		value !== "active" &&
		value !== "applying" &&
		value !== "choices" &&
		value !== "done"
	)
		throw new Error("invalid status");
	return value;
}

function parseTurnStatus(value: unknown): DialogueTurnStatus {
	if (value !== "pending" && value !== "done" && value !== "failed")
		throw new Error("corrupt turn status");
	return value;
}

function parseRequestId(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		value.length > 128 ||
		value.includes("\u0000")
	)
		throw new Error("invalid request ID");
	return value;
}

function parseDraftId(value: unknown): string | null {
	if (value === null) return null;
	return requireUuid(value, "draftId");
}

function parseSummary(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_SUMMARY_ITEMS)
		throw new Error("invalid summary");
	return value.map((item, index) =>
		optionalText(item, `summary ${String(index)}`, MAX_SUMMARY_ITEM),
	);
}

function parseChapters(value: unknown): Record<ChapterId, string> {
	const input = object(value, new Set(CHAPTER_IDS), "chapters");
	if (Object.keys(input).length !== CHAPTER_IDS.length)
		throw new Error("invalid chapters");
	const result = {} as Record<ChapterId, string>;
	for (const id of CHAPTER_IDS)
		result[id] = optionalText(
			field(input, id),
			`chapter ${id}`,
			MAX_CHAPTER_TEXT,
		);
	return result;
}

function parseUser(value: unknown): Partial<UserAnswers> {
	const input = object(value, new Set(USER_ANSWER_KEYS), "user");
	const result: Partial<UserAnswers> = {};
	for (const key of USER_ANSWER_KEYS) {
		if (!Object.hasOwn(input, key)) continue;
		result[key] = optionalText(field(input, key), key, MAX_USER_ANSWER);
	}
	return result;
}

function parseData(value: unknown, agentId: string): DialogueData {
	const input = object(
		value,
		new Set(["profile", "chapters", "user", "summary", "ready", "userSkipped"]),
		"data",
	);
	fields(
		input,
		[
			"profile",
			"chapters",
			"user",
			"summary",
			"ready",
			...(Object.hasOwn(input, "userSkipped") ? ["userSkipped"] : []),
		],
		"data",
	);
	const ready = field(input, "ready");
	if (typeof ready !== "boolean") throw new Error("invalid ready");
	const profile = validateAgentInput(field(input, "profile"));
	if (profile.id !== agentId) throw new Error("agent id mismatch");
	return {
		profile,
		chapters: parseChapters(field(input, "chapters")),
		user: parseUser(field(input, "user")),
		...(Object.hasOwn(input, "userSkipped")
			? { userSkipped: parseUserSkipped(input["userSkipped"]) }
			: {}),
		summary: parseSummary(field(input, "summary")),
		ready,
	};
}

function parseFinalization(value: unknown): Record<string, unknown> | null {
	if (value === null) return null;
	if (typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid finalization");
	const encoded = JSON.stringify(value);
	if (Buffer.byteLength(encoded, "utf8") > MAX_FINALIZATION_BYTES)
		throw new Error("finalization too large");
	return json<Record<string, unknown>>(encoded, "finalization");
}

function parseText(value: string): string {
	const text = optionalText(value, "text", MAX_TURN_TEXT);
	if (text.trim().length === 0) throw new Error("blank text");
	return text;
}

function parseReply(value: unknown): string {
	const reply = optionalText(value, "reply", MAX_TURN_REPLY);
	if (reply.trim().length === 0) throw new Error("blank reply");
	return reply;
}

function boundedError(value: unknown): string {
	const text = typeof value === "string" ? value : "failed";
	const clean = text.replaceAll("\u0000", "").trim() || "failed";
	return clean.length > MAX_DIALOGUE_ERROR
		? clean.slice(0, MAX_DIALOGUE_ERROR)
		: clean;
}

function parseCreate(value: CreateDialogueInput): {
	agentId: string;
	kind: DialogueKind;
	mode: InterviewMode;
	draftId: string | null;
	data: DialogueData;
} {
	const input = object(
		value,
		new Set(["agentId", "kind", "mode", "draftId", "data"]),
		"create",
	);
	fields(input, ["agentId", "kind", "mode", "draftId", "data"], "create");
	const agentId = boundedId(field(input, "agentId"), "agent id");
	return {
		agentId,
		kind: parseKind(field(input, "kind")),
		mode: parseInterviewMode(field(input, "mode")),
		draftId: parseDraftId(field(input, "draftId")),
		data: parseData(field(input, "data"), agentId),
	};
}

export class DialogueStore {
	private readonly db: DatabaseSync;
	private readonly now: () => number;
	private closed = false;

	constructor(path: string, now?: () => number) {
		if (typeof path !== "string" || path.length === 0)
			throw new Error("invalid dialogue store path");
		if (now !== undefined && typeof now !== "function")
			throw new Error("invalid dialogue store clock");
		this.now = now ?? Date.now;
		this.db =
			path === ":memory:"
				? new DatabaseSync(":memory:")
				: openCheckedDatabase(path).db;
		try {
			this.db.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE");
			this.assertNoForeignTables();
			for (const sql of SCHEMA.split(";")) if (sql.trim()) this.db.exec(sql);
			this.verifySchema();
			this.recoverPending();
			this.db.exec(
				"COMMIT; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
			);
		} catch (error) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			this.db.close();
			throw error;
		}
	}

	create(input: CreateDialogueInput): Room {
		this.assertOpen();
		const parsed = parseCreate(input);
		return this.transaction(() => {
			const open = this.db
				.prepare(
					"SELECT * FROM dialogue_rooms WHERE agent_id=? AND kind=? AND status != 'done' ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get(parsed.agentId, parsed.kind) as RoomRow | undefined;
			if (open) return this.decodeRoom(open);
			const count = (
				this.db
					.prepare(
						"SELECT COUNT(*) AS n FROM dialogue_rooms WHERE status != 'done'",
					)
					.get() as { n: number }
			).n;
			if (count >= MAX_NON_DONE_ROOMS) throw new Error("room capacity reached");
			const room: Room = {
				id: newUuid(),
				agentId: parsed.agentId,
				kind: parsed.kind,
				status: "active",
				revision: 0,
				mode: parsed.mode,
				draftId: parsed.draftId,
				data: parsed.data,
				createdAt: this.now(),
				finalization: null,
			};
			this.writeRoom(room);
			return room;
		});
	}

	get(id: string): Room | undefined {
		this.assertOpen();
		if (typeof id !== "string") return undefined;
		const row = this.db
			.prepare("SELECT * FROM dialogue_rooms WHERE id=?")
			.get(id) as RoomRow | undefined;
		return row ? this.decodeRoom(row) : undefined;
	}

	latest(agentId: string): Room | undefined {
		this.assertOpen();
		if (typeof agentId !== "string") return undefined;
		const row = this.db
			.prepare(
				"SELECT * FROM dialogue_rooms WHERE agent_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
			)
			.get(agentId) as RoomRow | undefined;
		return row ? this.decodeRoom(row) : undefined;
	}

	turns(id: string): Turn[] {
		this.assertOpen();
		requireUuid(id, "room id");
		if (!this.get(id)) throw new Error("unknown room");
		return (
			this.db
				.prepare(
					"SELECT * FROM dialogue_turns WHERE room_id=? ORDER BY seq ASC",
				)
				.all(id) as TurnRow[]
		).map((row) => this.decodeTurn(row));
	}

	begin(
		id: string,
		revision: number,
		requestId: string,
		text: string | null,
	): { room: Room; turn: Turn; replay: boolean } {
		this.assertOpen();
		requireUuid(id, "room id");
		const request = parseRequestId(requestId);
		if (text !== null && typeof text !== "string")
			throw new Error("invalid text");
		const parsedText = text === null ? null : parseText(text);
		return this.transaction(() => {
			const room = this.requireRoom(id);
			const existing = this.turnByRequest(id, request);
			if (existing) {
				if (existing.text !== parsedText) throw new Error("request conflict");
				if (existing.status === "done" || existing.status === "pending")
					return { room, turn: existing, replay: true };
				if (room.revision !== requireRevision(revision))
					throw new Error("stale revision");
				if (room.status !== "active") throw new Error("room is not active");
				if (this.pending(id)) throw new Error("pending conflict");
				const retried: Turn = {
					...existing,
					status: "pending",
					attempts: existing.attempts + 1,
					error: null,
				};
				this.writeTurn(id, request, retried);
				this.writeAttempt(id, retried.id, request, "retry", null);
				return { room, turn: retried, replay: false };
			}
			if (room.revision !== requireRevision(revision))
				throw new Error("stale revision");
			if (room.status !== "active") throw new Error("room is not active");
			if (this.pending(id)) throw new Error("pending conflict");
			const rows = this.db
				.prepare("SELECT * FROM dialogue_turns WHERE room_id=?")
				.all(id) as TurnRow[];
			if (parsedText === null && rows.length > 0)
				throw new Error("opening text only allowed on the first turn");
			const nonOpening = rows.filter((row) => row.text !== null).length;
			if (parsedText !== null && nonOpening >= MAX_NON_OPENING_TURNS)
				throw new Error("turn capacity reached");
			let used = 0;
			for (const row of rows) used += utf8(row.text) + utf8(row.reply);
			if (used + utf8(parsedText) > MAX_TRANSCRIPT_BYTES)
				throw new Error("transcript byte budget");
			const seq =
				(
					this.db
						.prepare(
							"SELECT COALESCE(MAX(seq), 0) AS n FROM dialogue_turns WHERE room_id=?",
						)
						.get(id) as { n: number }
				).n + 1;
			const turn: Turn = {
				id: newUuid(),
				requestId: request,
				seq,
				text: parsedText,
				reply: null,
				status: "pending",
				attempts: 1,
				error: null,
				summary: [],
				createdAt: this.now(),
				repliedAt: null,
			};
			this.writeTurn(id, request, turn);
			this.writeAttempt(id, turn.id, request, "begin", null);
			return { room, turn, replay: false };
		});
	}

	commit(
		id: string,
		requestId: string,
		revision: number,
		reply: string,
		data: DialogueData,
	): Room {
		this.assertOpen();
		requireUuid(id, "room id");
		const request = parseRequestId(requestId);
		const parsedReply = parseReply(reply);
		return this.transaction(() => {
			const room = this.requireRoom(id);
			const parsed = parseData(data, room.agentId);
			const turn = this.turnByRequest(id, request);
			if (!turn) throw new Error("unknown request");
			if (turn.status === "done") {
				if (turn.reply === parsedReply && isDeepStrictEqual(room.data, parsed))
					return room;
				throw new Error("request conflict");
			}
			if (turn.status !== "pending") throw new Error("turn is not pending");
			if (room.revision !== requireRevision(revision))
				throw new Error("stale revision");
			let used = 0;
			for (const row of this.db
				.prepare("SELECT id, text, reply FROM dialogue_turns WHERE room_id=?")
				.all(id) as {
				id: string;
				text: string | null;
				reply: string | null;
			}[]) {
				if (row.id === turn.id) continue;
				used += utf8(row.text) + utf8(row.reply);
			}
			if (used + utf8(turn.text) + utf8(parsedReply) > MAX_TRANSCRIPT_BYTES)
				throw new Error("transcript byte budget");
			const next: Room = {
				...room,
				revision: room.revision + 1,
				data: parsed,
			};
			const completed: Turn = {
				...turn,
				reply: parsedReply,
				status: "done",
				error: null,
				summary: parsed.summary,
				repliedAt: this.now(),
			};
			this.writeRoom(next);
			this.writeTurn(id, request, completed);
			return next;
		});
	}

	fail(id: string, requestId: string, error: unknown): void {
		this.assertOpen();
		requireUuid(id, "room id");
		const request = parseRequestId(requestId);
		const bounded = boundedError(error);
		this.transaction(() => {
			this.requireRoom(id);
			const turn = this.turnByRequest(id, request);
			if (!turn) throw new Error("unknown request");
			if (turn.status === "failed") return null;
			if (turn.status !== "pending") throw new Error("turn is not pending");
			const failed: Turn = {
				...turn,
				status: "failed",
				error: bounded,
			};
			this.writeTurn(id, request, failed);
			this.writeAttempt(id, failed.id, request, "fail", bounded);
			return null;
		});
	}

	patch(id: string, revision: number, patch: DialoguePatch): Room {
		this.assertOpen();
		requireUuid(id, "room id");
		const input = object(
			patch,
			new Set(["mode", "status", "finalization"]),
			"patch",
		);
		if (Object.keys(input).length === 0) throw new Error("empty patch");
		return this.transaction(() => {
			const room = this.requireRoom(id);
			if (room.revision !== requireRevision(revision))
				throw new Error("stale revision");
			if (this.pending(id)) throw new Error("pending conflict");
			if (room.status === "done") throw new Error("room is done");
			const nextMode =
				"mode" in input ? parseInterviewMode(field(input, "mode")) : room.mode;
			const nextStatus =
				"status" in input ? parseStatus(field(input, "status")) : room.status;
			if (
				nextStatus !== room.status &&
				!STATUS_NEXT[room.status].includes(nextStatus)
			)
				throw new Error("invalid status transition");
			let nextFinal = room.finalization;
			if ("finalization" in input) {
				const parsed = parseFinalization(field(input, "finalization"));
				if (
					room.status === "applying" &&
					!isDeepStrictEqual(parsed, room.finalization)
				)
					throw new Error("finalization is immutable");
				nextFinal = parsed;
			}
			if (nextStatus === "applying" && nextFinal === null)
				throw new Error("finalization required");
			const next: Room = {
				...room,
				mode: nextMode,
				status: nextStatus,
				finalization: nextFinal,
				revision: room.revision + 1,
			};
			this.writeRoom(next);
			return next;
		});
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private requireRoom(id: string): Room {
		const row = this.db
			.prepare("SELECT * FROM dialogue_rooms WHERE id=?")
			.get(id) as RoomRow | undefined;
		if (!row) throw new Error("unknown room");
		return this.decodeRoom(row);
	}

	private turnByRequest(roomId: string, requestId: string): Turn | undefined {
		const row = this.db
			.prepare("SELECT * FROM dialogue_turns WHERE room_id=? AND request_id=?")
			.get(roomId, requestId) as TurnRow | undefined;
		return row ? this.decodeTurn(row) : undefined;
	}

	private pending(roomId: string): TurnRow | undefined {
		return this.db
			.prepare(
				"SELECT * FROM dialogue_turns WHERE room_id=? AND status='pending' LIMIT 1",
			)
			.get(roomId) as TurnRow | undefined;
	}

	private writeRoom(room: Room): void {
		this.db
			.prepare(
				"INSERT INTO dialogue_rooms(id, agent_id, kind, status, revision, mode, draft_id, data_json, created_at, finalization_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agent_id=excluded.agent_id, kind=excluded.kind, status=excluded.status, revision=excluded.revision, mode=excluded.mode, draft_id=excluded.draft_id, data_json=excluded.data_json, created_at=excluded.created_at, finalization_json=excluded.finalization_json",
			)
			.run(
				room.id,
				room.agentId,
				room.kind,
				room.status,
				room.revision,
				room.mode,
				room.draftId,
				JSON.stringify(room.data),
				room.createdAt,
				room.finalization === null ? null : JSON.stringify(room.finalization),
			);
	}

	private writeTurn(roomId: string, requestId: string, turn: Turn): void {
		this.db
			.prepare(
				"INSERT INTO dialogue_turns(id, room_id, request_id, seq, text, reply, status, attempts, error, summary_json, created_at, replied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET request_id=excluded.request_id, seq=excluded.seq, text=excluded.text, reply=excluded.reply, status=excluded.status, attempts=excluded.attempts, error=excluded.error, summary_json=excluded.summary_json, created_at=excluded.created_at, replied_at=excluded.replied_at",
			)
			.run(
				turn.id,
				roomId,
				requestId,
				turn.seq,
				turn.text,
				turn.reply,
				turn.status,
				turn.attempts,
				turn.error,
				JSON.stringify(turn.summary),
				turn.createdAt,
				turn.repliedAt,
			);
	}

	private writeAttempt(
		roomId: string,
		turnId: string,
		requestId: string,
		event: "begin" | "retry" | "fail" | "recover",
		error: string | null,
	): void {
		this.db
			.prepare(
				"INSERT INTO dialogue_attempts(room_id, turn_id, request_id, event, error, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(roomId, turnId, requestId, event, error, this.now());
	}

	private recoverPending(): void {
		const rows = this.db
			.prepare("SELECT * FROM dialogue_turns WHERE status='pending'")
			.all() as TurnRow[];
		for (const row of rows) {
			this.db
				.prepare(
					"UPDATE dialogue_turns SET status='failed', error=? WHERE id=?",
				)
				.run("interrupted", row.id);
			this.writeAttempt(
				row.room_id,
				row.id,
				row.request_id,
				"recover",
				"interrupted",
			);
		}
	}

	private decodeRoom(row: RoomRow): Room {
		return clone({
			id: row.id,
			agentId: row.agent_id,
			kind: parseKind(row.kind),
			status: parseStatus(row.status),
			revision: row.revision,
			mode: parseInterviewMode(row.mode),
			draftId: row.draft_id,
			data: parseData(json(row.data_json, "room data"), row.agent_id),
			createdAt: row.created_at,
			finalization:
				row.finalization_json === null
					? null
					: parseFinalization(json(row.finalization_json, "finalization")),
		});
	}

	private decodeTurn(row: TurnRow): Turn {
		return clone({
			id: row.id,
			requestId: row.request_id,
			seq: row.seq,
			text: row.text,
			reply: row.reply,
			status: parseTurnStatus(row.status),
			attempts: row.attempts,
			error: row.error,
			summary: parseSummary(json(row.summary_json, "turn summary")),
			createdAt: row.created_at,
			repliedAt: row.replied_at,
		});
	}

	private verifySchema(): void {
		const expected: Record<string, string[]> = {
			dialogue_rooms: [
				"id",
				"agent_id",
				"kind",
				"status",
				"revision",
				"mode",
				"draft_id",
				"data_json",
				"created_at",
				"finalization_json",
			],
			dialogue_turns: [
				"id",
				"room_id",
				"request_id",
				"seq",
				"text",
				"reply",
				"status",
				"attempts",
				"error",
				"summary_json",
				"created_at",
				"replied_at",
			],
			dialogue_attempts: [
				"id",
				"room_id",
				"turn_id",
				"request_id",
				"event",
				"error",
				"created_at",
			],
		};
		for (const [table, columns] of Object.entries(expected)) {
			const actual = (
				this.db.prepare(`PRAGMA table_info(${table})`).all() as {
					name: string;
				}[]
			).map((row) => row.name);
			if (!isDeepStrictEqual(actual, columns))
				throw new Error("unknown dialogue schema");
		}
	}

	private assertNoForeignTables(): void {
		const owned = new Set([
			"dialogue_rooms",
			"dialogue_turns",
			"dialogue_attempts",
		]);
		const tables = (
			this.db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'",
				)
				.all() as { name: string }[]
		).map((row) => row.name);
		if (tables.some((table) => !owned.has(table)))
			throw new Error("foreign dialogue database schema");
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return clone(result);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("dialogue store is closed");
	}
}
