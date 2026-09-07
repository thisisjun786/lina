import { publicIdentity } from "./config.ts";
import { OpenVikingTransport } from "./transport.ts";
import {
	isWriteMode,
	type OpenVikingClientOptions,
	type OpenVikingConfig,
	type OpenVikingFindResult,
	type OpenVikingHit,
	type OpenVikingListEntry,
	type OpenVikingListResult,
	type OpenVikingReadResult,
	OpenVikingRequestError,
	type OpenVikingStatus,
	type OpenVikingWriteMode,
	type OpenVikingWriteResult,
} from "./types.ts";
import { resolveWorkUri } from "./uri.ts";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_BODY_CAP = 256 * 1024;

function object(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new OpenVikingRequestError(
			`openviking ${label} is not an object`,
			"body",
		);
	return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string")
		throw new OpenVikingRequestError(
			`openviking ${label} is not a string`,
			"body",
		);
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function parseEntry(value: unknown): OpenVikingListEntry {
	const fields = object(value, "directory entry");
	const entry: OpenVikingListEntry = {
		uri: string(fields["uri"], "entry uri"),
		name: string(fields["name"], "entry name"),
		isDir: fields["isDir"] === true,
	};
	const relPath =
		optionalString(fields["rel_path"]) ?? optionalString(fields["relPath"]);
	if (relPath !== undefined) entry.relPath = relPath;
	return entry;
}

function hitKind(
	value: unknown,
	fallback: OpenVikingHit["kind"],
): OpenVikingHit["kind"] {
	if (value === "memory" || value === "resource" || value === "skill")
		return value;
	if (value === "memories") return "memory";
	if (value === "resources") return "resource";
	if (value === "skills") return "skill";
	return fallback;
}

function parseHit(
	value: unknown,
	fallback: OpenVikingHit["kind"],
): OpenVikingHit {
	const fields = object(value, "search hit");
	const abstract = optionalString(fields["abstract"]);
	const sourceId =
		optionalString(fields["sourceId"]) ?? optionalString(fields["source_id"]);
	const taskId =
		optionalString(fields["taskId"]) ?? optionalString(fields["task_id"]);
	const hit: OpenVikingHit = {
		uri: string(fields["uri"], "hit uri"),
		kind: hitKind(fields["context_type"] ?? fields["kind"], fallback),
	};
	const score = optionalNumber(fields["score"]);
	if (score !== undefined) hit.score = score;
	if (abstract !== undefined) hit.abstract = abstract;
	if (sourceId !== undefined) hit.sourceId = sourceId;
	if (taskId !== undefined) hit.taskId = taskId;
	return hit;
}

function parseHits(result: unknown): OpenVikingHit[] {
	const fields = object(result, "find result");
	const hits: OpenVikingHit[] = [];
	for (const [key, kind] of [
		["memories", "memory"],
		["resources", "resource"],
		["skills", "skill"],
	] as const) {
		const items = fields[key];
		if (items === undefined) continue;
		if (!Array.isArray(items))
			throw new OpenVikingRequestError(
				`openviking ${key} is not an array`,
				"body",
			);
		for (const item of items) hits.push(parseHit(item, kind));
	}
	return hits;
}

function query(
	path: string,
	params: Record<string, string | number | undefined>,
): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) continue;
		search.set(key, String(value));
	}
	const encoded = search.toString();
	return encoded.length > 0 ? `${path}?${encoded}` : path;
}

export class OpenVikingClient {
	readonly status: OpenVikingStatus;
	private readonly config: OpenVikingConfig | undefined;
	private readonly transport: OpenVikingTransport | undefined;

	constructor(
		config?: OpenVikingConfig,
		options: OpenVikingClientOptions = {},
	) {
		this.config = config;
		this.status = config
			? {
					service: "configured",
					...publicIdentity(config),
				}
			: { service: "disabled", reason: "LINA_OPENVIKING_* is unset" };
		this.transport = config
			? new OpenVikingTransport({
					baseUrl: config.baseUrl,
					apiKey: config.apiKey,
					fetch: options.fetch ?? ((input, init) => fetch(input, init)),
					timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
					bodyCapBytes: options.bodyCapBytes ?? DEFAULT_BODY_CAP,
				})
			: undefined;
	}

	private requireTransport(): {
		config: OpenVikingConfig;
		transport: OpenVikingTransport;
	} {
		if (this.config === undefined || this.transport === undefined)
			throw new OpenVikingRequestError("openviking is disabled", "disabled");
		return { config: this.config, transport: this.transport };
	}

	private resolve(uri: string | undefined): string {
		const { config } = this.requireTransport();
		try {
			return resolveWorkUri(config.rootUri, uri);
		} catch (error) {
			throw new OpenVikingRequestError(
				error instanceof Error ? error.message : "unsafe openviking uri",
				"uri",
			);
		}
	}

	async list(
		uri?: string,
		signal?: AbortSignal,
	): Promise<OpenVikingListResult> {
		const { transport } = this.requireTransport();
		const resolved = this.resolve(uri);
		const result = transport.unwrap(
			await transport.request(
				"GET",
				query("/api/v1/fs/ls", { uri: resolved, output: "original" }),
				undefined,
				signal,
			),
		);
		if (!Array.isArray(result))
			throw new OpenVikingRequestError(
				"openviking ls result is not an array",
				"body",
			);
		return { uri: resolved, entries: result.map(parseEntry) };
	}

	async read(
		uri: string,
		offset?: number,
		limit?: number,
		signal?: AbortSignal,
	): Promise<OpenVikingReadResult> {
		const { transport } = this.requireTransport();
		const resolved = this.resolve(uri);
		const result = transport.unwrap(
			await transport.request(
				"GET",
				query("/api/v1/content/read", { uri: resolved, offset, limit }),
				undefined,
				signal,
			),
		);
		const content =
			typeof result === "string"
				? result
				: string(object(result, "read result")["content"], "read content");
		const read: OpenVikingReadResult = { uri: resolved, content };
		if (offset !== undefined) read.offset = offset;
		if (limit !== undefined) read.limit = limit;
		return read;
	}

	async find(
		searchQuery: string,
		uri?: string,
		signal?: AbortSignal,
	): Promise<OpenVikingFindResult> {
		const { transport } = this.requireTransport();
		if (typeof searchQuery !== "string" || !searchQuery.trim())
			throw new OpenVikingRequestError(
				"openviking query must not be empty",
				"uri",
			);
		const resolved = this.resolve(uri);
		const result = transport.unwrap(
			await transport.request(
				"POST",
				"/api/v1/search/find",
				{ query: searchQuery, target_uri: resolved },
				signal,
			),
		);
		return {
			query: searchQuery,
			uri: resolved,
			hits: parseHits(result),
		};
	}

	async write(
		uri: string,
		content: string,
		mode: OpenVikingWriteMode,
		signal?: AbortSignal,
	): Promise<OpenVikingWriteResult> {
		const { transport } = this.requireTransport();
		if (!isWriteMode(mode))
			throw new OpenVikingRequestError(
				`unsupported openviking write mode ${String(mode)}`,
				"uri",
			);
		if (typeof content !== "string")
			throw new OpenVikingRequestError(
				"openviking write content must be a string",
				"uri",
			);
		const resolved = this.resolve(uri);
		const result = object(
			transport.unwrap(
				await transport.request(
					"POST",
					"/api/v1/content/write",
					{ uri: resolved, content, mode, wait: false },
					signal,
				),
			),
			"write result",
		);
		const semanticStatus =
			optionalString(result["semantic_status"]) ?? "unknown";
		const vectorStatus = optionalString(result["vector_status"]) ?? "unknown";
		const writtenBytes =
			optionalNumber(result["written_bytes"]) ?? content.length;
		return {
			uri: optionalString(result["uri"]) ?? resolved,
			mode,
			writtenBytes,
			semanticStatus,
			vectorStatus,
			retrievalReady:
				semanticStatus === "complete" && vectorStatus === "complete",
		};
	}
}
