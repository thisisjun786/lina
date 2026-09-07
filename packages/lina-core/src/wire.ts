import type {
	HistoryPage,
	RequestRecord,
	RequestStatus,
	SessionSnapshot,
	TimelineEntry,
	ToolMetadata,
} from "./protocol.ts";
import { TOOL_NAME_MAX_CHARS } from "./protocol.ts";

export type ChatCommand = {
	type: "chat";
	id: string;
	text: string;
	sessionId?: string;
};
export type WireClient =
	| ChatCommand
	| {
			type: "search";
			sessionId: string;
			requestId: string;
			query: string;
			before: number;
	  }
	| { type: "subscribe"; version: 2 }
	| { type: "ping"; sessionId: string; nonce: string }
	| { type: "history"; sessionId: string; before: number }
	| {
			type: "entry";
			sessionId: string;
			entryId: string;
			offset: number;
			requestId?: string;
	  };
export type WireServer =
	| {
			type: "search-error";
			sessionId: string;
			requestId: string;
			message: string;
	  }
	| {
			type: "search-results";
			sessionId: string;
			requestId: string;
			page: HistoryPage;
	  }
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "pong"; sessionId: string; nonce: string }
	| {
			type: "history";
			sessionId: string;
			revision: number;
			before: number;
			page: HistoryPage;
	  }
	| {
			type: "entry-text";
			requestId?: string;
			sessionId: string;
			entryId: string;
			offset: number;
			text: string;
			nextOffset: number | null;
	  }
	| { type: "live-text"; sessionId: string; text: string };

type Fields = Partial<
	Record<
		| "type"
		| "version"
		| "id"
		| "text"
		| "sessionId"
		| "nonce"
		| "query"
		| "message"
		| "requestId"
		| "before"
		| "entryId"
		| "offset"
		| "nextOffset"
		| "snapshot"
		| "revision"
		| "page"
		| "messages"
		| "requests"
		| "hasEarlier"
		| "beforeCursor"
		| "seq"
		| "role"
		| "timestamp"
		| "truncated"
		| "status"
		| "createdAt"
		| "updatedAt"
		| "error"
		| "botId"
		| "state"
		| "tool"
		| "name"
		| "isError",
		unknown
	>
>;
function record(value: unknown): Fields | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Fields)
		: undefined;
}
function decode(raw: unknown): Fields | undefined {
	if (typeof raw !== "string" || raw.length > 4_194_304) return;
	try {
		return record(JSON.parse(raw));
	} catch {
		return;
	}
}
function id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function string(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}

export function parseWireClient(raw: unknown): WireClient | undefined {
	const value = decode(raw);
	if (!value) return;
	if (
		value.type === "subscribe" &&
		value.version === 2 &&
		Object.keys(value).length === 2
	)
		return { type: "subscribe", version: 2 };
	if (
		value.type === "chat" &&
		id(value.id) &&
		string(value.text, 16000) &&
		value.text.trim() &&
		(value.sessionId === undefined || id(value.sessionId)) &&
		Object.keys(value).length === (value.sessionId === undefined ? 3 : 4)
	)
		return {
			type: "chat",
			id: value.id,
			text: value.text,
			...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
		};
	if (!id(value.sessionId)) return;
	if (
		value.type === "search" &&
		id(value.requestId) &&
		string(value.query, 512) &&
		value.query.trim() &&
		integer(value.before) &&
		value.before > 0 &&
		Object.keys(value).length === 5
	)
		return {
			type: "search",
			sessionId: value.sessionId,
			requestId: value.requestId,
			query: value.query,
			before: value.before,
		};
	if (
		value.type === "ping" &&
		id(value.nonce) &&
		Object.keys(value).length === 3
	)
		return { type: "ping", sessionId: value.sessionId, nonce: value.nonce };
	if (
		value.type === "history" &&
		integer(value.before) &&
		value.before > 0 &&
		Object.keys(value).length === 3
	)
		return {
			type: "history",
			sessionId: value.sessionId,
			before: value.before,
		};
	if (
		value.type === "entry" &&
		id(value.entryId) &&
		integer(value.offset) &&
		(value.requestId === undefined || id(value.requestId)) &&
		Object.keys(value).length === (value.requestId === undefined ? 4 : 5)
	)
		return {
			type: "entry",
			sessionId: value.sessionId,
			entryId: value.entryId,
			offset: value.offset,
			...(value.requestId === undefined ? {} : { requestId: value.requestId }),
		};
	return;
}

/** Returns the parsed metadata, undefined when absent, or null when malformed. */
function toolMetadata(
	raw: unknown,
	role: TimelineEntry["role"],
): ToolMetadata | undefined | null {
	if (raw === undefined) return undefined;
	const value = record(raw);
	if (
		!value ||
		role !== "tool" ||
		typeof value.name !== "string" ||
		value.name.length === 0 ||
		value.name.length > TOOL_NAME_MAX_CHARS ||
		(value.isError !== undefined && typeof value.isError !== "boolean")
	)
		return null;
	return {
		name: value.name,
		...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
	};
}
function timeline(raw: unknown): TimelineEntry | undefined {
	const value = record(raw);
	if (
		!value ||
		!integer(value.seq) ||
		value.seq < 1 ||
		!id(value.entryId) ||
		!string(value.text, 4096) ||
		!string(value.timestamp, 64) ||
		typeof value.truncated !== "boolean" ||
		(value.role !== "user" &&
			value.role !== "assistant" &&
			value.role !== "tool")
	)
		return;
	const tool = toolMetadata(value.tool, value.role);
	if (tool === null) return;
	return {
		seq: value.seq,
		entryId: value.entryId,
		role: value.role,
		text: value.text,
		timestamp: value.timestamp,
		truncated: value.truncated,
		...(tool ? { tool } : {}),
	};
}
function history(raw: unknown): HistoryPage | undefined {
	const value = record(raw);
	if (
		!value ||
		!Array.isArray(value.messages) ||
		value.messages.length > 200 ||
		typeof value.hasEarlier !== "boolean" ||
		(value.beforeCursor !== null && !integer(value.beforeCursor))
	)
		return;
	const messages: TimelineEntry[] = [];
	for (const item of value.messages) {
		const message = timeline(item);
		if (!message || (messages.at(-1)?.seq ?? 0) >= message.seq) return;
		messages.push(message);
	}
	return {
		messages,
		hasEarlier: value.hasEarlier,
		beforeCursor: value.beforeCursor,
	};
}
function request(raw: unknown, sessionId: string): RequestRecord | undefined {
	const value = record(raw);
	if (
		!value ||
		!id(value.id) ||
		value.sessionId !== sessionId ||
		!string(value.text, 4096) ||
		!string(value.createdAt, 64) ||
		!string(value.updatedAt, 64) ||
		(value.error !== undefined && !string(value.error, 1024)) ||
		(value.entryId !== undefined && !id(value.entryId))
	)
		return;
	const status = value.status;
	if (
		status !== "queued" &&
		status !== "accepted" &&
		status !== "settled" &&
		status !== "rejected" &&
		status !== "interrupted"
	)
		return;
	return {
		id: value.id,
		sessionId,
		text: value.text,
		status: status as RequestStatus,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(value.error === undefined ? {} : { error: value.error }),
		...(value.entryId === undefined ? {} : { entryId: value.entryId }),
	};
}
function snapshot(raw: unknown): SessionSnapshot | undefined {
	const value = record(raw);
	const page = history(raw);
	if (
		!value ||
		!page ||
		value.version !== 2 ||
		!id(value.botId) ||
		!id(value.sessionId) ||
		!integer(value.revision) ||
		(value.state !== "idle" && value.state !== "running") ||
		!Array.isArray(value.requests) ||
		value.requests.length > 200
	)
		return;
	const requests: RequestRecord[] = [];
	for (const item of value.requests) {
		const parsed = request(item, value.sessionId);
		if (!parsed) return;
		requests.push(parsed);
	}
	return {
		version: 2,
		botId: value.botId,
		sessionId: value.sessionId,
		revision: value.revision,
		state: value.state,
		...page,
		requests,
	};
}

export function parseWireServer(raw: unknown): WireServer | undefined {
	const value = decode(raw);
	if (!value) return;
	if (value.type === "snapshot") {
		const parsed = snapshot(value.snapshot);
		return parsed ? { type: "snapshot", snapshot: parsed } : undefined;
	}
	if (!id(value.sessionId)) return;
	if (
		value.type === "search-error" &&
		id(value.requestId) &&
		string(value.message, 512) &&
		Object.keys(value).length === 4
	)
		return {
			type: "search-error",
			sessionId: value.sessionId,
			requestId: value.requestId,
			message: value.message,
		};
	if (
		value.type === "search-results" &&
		id(value.requestId) &&
		Object.keys(value).length === 4
	) {
		const page = history(value.page);
		return page
			? {
					type: "search-results",
					sessionId: value.sessionId,
					requestId: value.requestId,
					page,
				}
			: undefined;
	}
	if (
		value.type === "pong" &&
		id(value.nonce) &&
		Object.keys(value).length === 3
	)
		return { type: "pong", sessionId: value.sessionId, nonce: value.nonce };
	if (value.type === "live-text" && string(value.text, 16384))
		return { type: "live-text", sessionId: value.sessionId, text: value.text };
	if (
		value.type === "history" &&
		integer(value.revision) &&
		integer(value.before) &&
		value.before > 0
	) {
		const page = history(value.page);
		const before = value.before;
		if (page?.messages.some((entry) => entry.seq >= before)) return;
		return page
			? {
					type: "history",
					sessionId: value.sessionId,
					revision: value.revision,
					before: value.before,
					page,
				}
			: undefined;
	}
	if (
		value.type === "entry-text" &&
		id(value.entryId) &&
		integer(value.offset) &&
		string(value.text, 8192) &&
		(value.requestId === undefined || id(value.requestId)) &&
		(value.nextOffset === null || integer(value.nextOffset))
	)
		return {
			type: "entry-text",
			sessionId: value.sessionId,
			entryId: value.entryId,
			offset: value.offset,
			text: value.text,
			nextOffset: value.nextOffset,
			...(value.requestId === undefined ? {} : { requestId: value.requestId }),
		};
	return;
}
