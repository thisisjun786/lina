export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 200;
export const PREVIEW_MAX_CHARS = 4096;
export const REQUEST_MAX_CHARS = 16000;
export const TOOL_NAME_MAX_CHARS = 64;

export interface BotBinding {
	version: 1;
	botId: string;
	sessionId: string;
	sessionFile: string;
	workspace: string;
}

export interface EntryInput {
	entryId: string;
	role: "user" | "assistant" | "tool" | "meta";
	text: string;
	timestamp: string;
	raw: unknown;
}

/**
 * Derived from the persisted raw tool result; absent for legacy or non-tool rows.
 * isError is true/false only when the native record observed it; missing or
 * malformed status stays undefined so the UI never claims completion.
 */
export interface ToolMetadata {
	name: string;
	isError?: boolean;
}

export interface TimelineEntry {
	seq: number;
	entryId: string;
	role: EntryInput["role"];
	text: string;
	timestamp: string;
	truncated: boolean;
	tool?: ToolMetadata;
}

export type RequestStatus =
	| "queued"
	| "accepted"
	| "settled"
	| "rejected"
	| "interrupted";

export interface RequestRecord {
	id: string;
	sessionId: string;
	text: string;
	status: RequestStatus;
	createdAt: string;
	updatedAt: string;
	error?: string;
	entryId?: string;
}

export interface HistoryPage {
	messages: TimelineEntry[];
	hasEarlier: boolean;
	beforeCursor: number | null;
}

export interface SessionSnapshot extends HistoryPage {
	version: 2;
	botId: string;
	sessionId: string;
	revision: number;
	state: "idle" | "running";
	requests: RequestRecord[];
}
