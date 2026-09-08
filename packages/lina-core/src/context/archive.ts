import type { EntryInput } from "../protocol.ts";
import { isOrdinarySource, type SourceEntry } from "../source-policy.ts";

type Block = Record<string, unknown>;

function record(value: unknown): Block | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Block)
		: undefined;
}

/** Native summary wrappers have no independent ancestry; use ContextStore nodes. */
export function isOrdinaryArchiveEntry(
	entry: (EntryInput & SourceEntry) | undefined,
): entry is EntryInput & SourceEntry {
	if (!entry || !isOrdinarySource(entry) || entry.role === "meta") return false;
	const raw = record(entry.raw),
		message = record(raw?.["message"]);
	return (
		!["compaction", "branch_summary"].includes(String(raw?.["type"])) &&
		!["compactionSummary", "branchSummary"].includes(String(message?.["role"]))
	);
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = record(value);
	if (!object) return JSON.stringify(value) ?? "null";
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}

function describeAttachment(block: Block): string {
	const mime = typeof block["mimeType"] === "string" ? block["mimeType"] : "";
	const data = block["data"];
	const size =
		typeof data === "string"
			? ` base64-chars=${data.length}`
			: typeof block["size"] === "number"
				? ` bytes=${block["size"]}`
				: "";
	const name =
		typeof block["fileName"] === "string"
			? ` name=${JSON.stringify(block["fileName"])}`
			: "";
	return `[attachment ${mime || "unknown"}${name}${size}]`;
}

/**
 * Deterministic archive projection of a content block list: visible text,
 * tool-call name/arguments and attachment descriptors. Thinking, signatures
 * and binary payloads are never emitted.
 */
function projectContent(content: unknown): string[] {
	if (typeof content === "string") return content ? [content] : [];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const item of content) {
		const block = record(item);
		if (!block) continue;
		switch (block["type"]) {
			case "text":
				if (typeof block["text"] === "string" && block["text"])
					parts.push(block["text"]);
				break;
			case "toolCall":
			case "tool_call": {
				const name =
					typeof block["name"] === "string" ? block["name"] : "unknown";
				const args = block["arguments"] ?? block["input"] ?? {};
				parts.push(`[tool call ${name}] ${stableJson(args)}`);
				break;
			}
			case "image":
			case "file":
			case "document":
			case "attachment":
				parts.push(describeAttachment(block));
				break;
			default:
				break;
		}
	}
	return parts;
}

/**
 * Visible archive text for one immutable entry. Uses the raw native JSON so
 * tool-call-only and attachment-only entries remain reachable, while private
 * reasoning, signatures and base64 image bytes are excluded.
 */
export function archiveText(entry: EntryInput): string {
	const raw = record(entry.raw);
	// Legacy native compaction/branch summaries carry their text at the entry level.
	if (
		(raw?.["type"] === "compaction" || raw?.["type"] === "branch_summary") &&
		typeof raw["summary"] === "string" &&
		raw["summary"]
	)
		return raw["summary"];
	const message = record(raw?.["message"]);
	if (!message) return entry.text;
	const parts: string[] = [];
	switch (message["role"]) {
		case "toolResult": {
			const name =
				typeof message["toolName"] === "string" ? message["toolName"] : "";
			const error = message["isError"] === true ? " error" : "";
			parts.push(`[tool result${name ? ` ${name}` : ""}${error}]`);
			parts.push(...projectContent(message["content"]));
			break;
		}
		case "bashExecution": {
			if (typeof message["command"] === "string")
				parts.push(`[bash] ${message["command"]}`);
			if (typeof message["output"] === "string" && message["output"])
				parts.push(message["output"]);
			break;
		}
		case "compactionSummary":
		case "branchSummary":
			if (typeof message["summary"] === "string")
				parts.push(message["summary"]);
			break;
		default:
			parts.push(...projectContent(message["content"]));
			break;
	}
	const text = parts.join("\n\n");
	return text || entry.text;
}
