export type OpenVikingWriteMode = "create" | "append" | "replace";

export interface OpenVikingConfig {
	baseUrl: string;
	apiKey: string;
	rootUri: string;
}

export interface OpenVikingIdentity {
	baseUrl: string;
	rootUri: string;
}

export type OpenVikingStatus =
	| { service: "disabled"; reason: string }
	| { service: "configured"; baseUrl: string; rootUri: string };

export interface OpenVikingListEntry {
	uri: string;
	name: string;
	isDir: boolean;
	relPath?: string;
}

export interface OpenVikingListResult {
	uri: string;
	entries: OpenVikingListEntry[];
}

export interface OpenVikingReadResult {
	uri: string;
	content: string;
	offset?: number;
	limit?: number;
}

export interface OpenVikingHit {
	uri: string;
	kind: "memory" | "resource" | "skill";
	score?: number;
	abstract?: string;
	sourceId?: string;
	taskId?: string;
}

export interface OpenVikingFindResult {
	query: string;
	uri: string;
	hits: OpenVikingHit[];
}

export interface OpenVikingWriteResult {
	uri: string;
	mode: OpenVikingWriteMode;
	writtenBytes: number;
	semanticStatus: string;
	vectorStatus: string;
	retrievalReady: boolean;
}

export type JsonSchema = {
	type: "object";
	properties: Record<string, unknown>;
	required?: string[];
	additionalProperties: false;
};

export type OpenVikingToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
};

export type OpenVikingTool = {
	name: string;
	label: string;
	description: string;
	parameters: JsonSchema;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<OpenVikingToolResult>;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenVikingClientOptions {
	fetch?: FetchLike;
	timeoutMs?: number;
	bodyCapBytes?: number;
}

export class OpenVikingRequestError extends Error {
	constructor(
		message: string,
		readonly kind:
			| "network"
			| "timeout"
			| "redirect"
			| "status"
			| "body"
			| "disabled"
			| "uri",
		readonly status?: number,
	) {
		super(message);
		this.name = "OpenVikingRequestError";
	}
}

export const WRITE_MODES = ["create", "append", "replace"] as const;

export function isWriteMode(value: unknown): value is OpenVikingWriteMode {
	return value === "create" || value === "append" || value === "replace";
}

export function artifactRefs(text: string): {
	sourceIds: string[];
	taskIds: string[];
} {
	const sourceIds: string[] = [];
	const taskIds: string[] = [];
	const sourceRe = /(?:^|[^A-Za-z0-9_])source +([A-Za-z0-9._:-]+)/gi;
	const taskRe = /(?:^|[^A-Za-z0-9_])task +([A-Za-z0-9._:-]+)/gi;
	for (const match of text.matchAll(sourceRe)) {
		const id = match[1];
		if (id !== undefined && !sourceIds.includes(id)) sourceIds.push(id);
	}
	for (const match of text.matchAll(taskRe)) {
		const id = match[1];
		if (id !== undefined && !taskIds.includes(id)) taskIds.push(id);
	}
	return { sourceIds, taskIds };
}
