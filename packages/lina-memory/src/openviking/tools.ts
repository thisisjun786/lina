import type { OpenVikingClient } from "./client.ts";
import {
	artifactRefs,
	isWriteMode,
	type JsonSchema,
	OpenVikingRequestError,
	type OpenVikingTool,
	type OpenVikingToolResult,
} from "./types.ts";

function schema(
	properties: Record<string, unknown>,
	required?: string[],
): JsonSchema {
	return required
		? { type: "object", properties, required, additionalProperties: false }
		: { type: "object", properties, additionalProperties: false };
}

function textResult(
	text: string,
	details: Record<string, unknown>,
): OpenVikingToolResult {
	return { content: [{ type: "text", text }], details };
}

function failure(error: unknown): OpenVikingToolResult {
	if (error instanceof OpenVikingRequestError && error.kind === "disabled")
		return textResult("OpenViking work memory is disabled.", {
			service: "disabled",
		});
	const message =
		error instanceof Error ? error.message : "openviking request failed";
	const details: Record<string, unknown> = {
		service: "unavailable",
		message,
	};
	if (error instanceof OpenVikingRequestError) {
		details["kind"] = error.kind;
		if (error.status !== undefined) details["status"] = error.status;
	}
	return textResult(message, details);
}

function stringParam(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim())
		throw new OpenVikingRequestError(`missing openviking ${key}`, "uri");
	return value;
}

function optionalStringParam(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new OpenVikingRequestError(`invalid openviking ${key}`, "uri");
	return value;
}

function optionalIntegerParam(
	params: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = params[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value))
		throw new OpenVikingRequestError(`invalid openviking ${key}`, "uri");
	return value;
}

export function createOpenVikingTools(
	client: OpenVikingClient,
): OpenVikingTool[] {
	const list: OpenVikingTool = {
		name: "lina_work_list",
		label: "List work memory",
		description:
			"List files under the configured OpenViking project resource root. URIs are viking:// workbench paths, not local filesystem paths. Missing configuration is reported as disabled, not as an empty directory.",
		parameters: schema({
			uri: {
				type: "string",
				description:
					"Optional viking:// URI or root-relative path inside the project root",
			},
		}),
		async execute(_id, params, signal) {
			try {
				const listed = await client.list(
					optionalStringParam(params, "uri"),
					signal,
				);
				return textResult(JSON.stringify(listed), {
					service: client.status.service,
					uri: listed.uri,
					entries: listed.entries,
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
	const read: OpenVikingTool = {
		name: "lina_work_read",
		label: "Read work memory",
		description:
			"Read one OpenViking workbench file as text. Expand a search hit with this tool before relying on its abstract. Failures are errors, not empty files.",
		parameters: schema(
			{
				uri: {
					type: "string",
					minLength: 1,
					description: "viking:// URI or root-relative path to read",
				},
				offset: {
					type: "integer",
					minimum: 0,
					description: "Starting line number (0-indexed)",
				},
				limit: {
					type: "integer",
					minimum: -1,
					description: "Number of lines to read; -1 reads to the end",
				},
			},
			["uri"],
		),
		async execute(_id, params, signal) {
			try {
				const result = await client.read(
					stringParam(params, "uri"),
					optionalIntegerParam(params, "offset"),
					optionalIntegerParam(params, "limit"),
					signal,
				);
				return textResult(result.content, {
					service: client.status.service,
					uri: result.uri,
					...artifactRefs(result.content),
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
	const search: OpenVikingTool = {
		name: "lina_work_search",
		label: "Search work memory",
		description:
			"Ranked OpenViking find over the configured project resource root. Hits keep source and task identifiers when present. Server errors are reported; they are not empty hit lists.",
		parameters: schema(
			{
				query: {
					type: "string",
					minLength: 1,
					description: "Search query over shared work memory",
				},
				uri: {
					type: "string",
					description: "Optional subtree URI inside the project root",
				},
			},
			["query"],
		),
		async execute(_id, params, signal) {
			try {
				const found = await client.find(
					stringParam(params, "query"),
					optionalStringParam(params, "uri"),
					signal,
				);
				return textResult(JSON.stringify(found), {
					service: client.status.service,
					query: found.query,
					uri: found.uri,
					hits: found.hits,
				});
			} catch (error) {
				return failure(error);
			}
		},
	};
	const write: OpenVikingTool = {
		name: "lina_work_write",
		label: "Write work memory",
		description:
			"Create, append, or replace a text file under the OpenViking project resource root. Writes refresh semantic search in the background and are not retrieval-ready until indexing completes. This tool does not import arbitrary local filesystem paths.",
		parameters: schema(
			{
				uri: {
					type: "string",
					minLength: 1,
					description: "viking:// URI or root-relative path to write",
				},
				content: {
					type: "string",
					description: "Text content to write",
				},
				mode: {
					type: "string",
					enum: ["create", "append", "replace"],
					description:
						"create fails if the file exists; append requires an existing file; replace overwrites",
				},
			},
			["uri", "content", "mode"],
		),
		async execute(_id, params, signal) {
			try {
				const mode = params["mode"];
				if (!isWriteMode(mode))
					throw new OpenVikingRequestError(
						"unsupported openviking write mode",
						"uri",
					);
				const content = params["content"];
				if (typeof content !== "string")
					throw new OpenVikingRequestError(
						"openviking write content must be a string",
						"uri",
					);
				const written = await client.write(
					stringParam(params, "uri"),
					content,
					mode,
					signal,
				);
				const ready = written.retrievalReady
					? "Indexes report complete."
					: "Indexing is asynchronous; this write is not retrieval-ready.";
				return textResult(
					`Wrote ${written.writtenBytes} bytes to ${written.uri} (mode=${written.mode}). ${ready} semantic=${written.semanticStatus}, vector=${written.vectorStatus}.`,
					{
						service: client.status.service,
						uri: written.uri,
						mode: written.mode,
						writtenBytes: written.writtenBytes,
						semanticStatus: written.semanticStatus,
						vectorStatus: written.vectorStatus,
						retrievalReady: written.retrievalReady,
					},
				);
			} catch (error) {
				return failure(error);
			}
		},
	};
	return [list, read, search, write];
}
