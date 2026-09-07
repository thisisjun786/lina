import type { EntryInput, TimelineEntry, ToolMetadata } from "./protocol.ts";
import { TOOL_NAME_MAX_CHARS } from "./protocol.ts";

/**
 * SQL projection of the three native fields needed for tool metadata. Only
 * these scalars leave SQLite; full raw bodies stay on disk. json_valid guards
 * SQLite's nesting limit too; valid JavaScript JSON may exceed that limit.
 */
export const TOOL_METADATA_COLUMNS = `
 CASE WHEN role = 'tool' AND json_valid(raw_json)
  THEN json_extract(raw_json, '$.message.role') END AS native_role,
 CASE WHEN role = 'tool' AND json_valid(raw_json)
  THEN CASE WHEN json_type(raw_json, '$.message.toolName') = 'text'
   THEN json_extract(raw_json, '$.message.toolName') END END AS tool_name,
 CASE WHEN role = 'tool' AND json_valid(raw_json)
  THEN json_type(raw_json, '$.message.isError') END AS tool_error_type`;

export interface ToolMetadataRow {
	native_role: unknown;
	tool_name: unknown;
	tool_error_type: unknown;
}

/**
 * Guarded projection of tool metadata from persisted native fields. Legacy or
 * malformed records yield no metadata; the caller renders a neutral generic
 * tool row instead. Raw JSON is never rewritten.
 */
export function projectToolMetadata(
	role: EntryInput["role"],
	row: ToolMetadataRow,
): ToolMetadata | undefined {
	if (role !== "tool" || row.native_role !== "toolResult") return;
	const name = row.tool_name;
	if (typeof name !== "string" || name.length === 0) return;
	return {
		name: name.slice(0, TOOL_NAME_MAX_CHARS),
		...(row.tool_error_type === "true"
			? { isError: true }
			: row.tool_error_type === "false"
				? { isError: false }
				: {}),
	};
}

/** Adds the optional tool field only when metadata exists, keeping legacy rows unchanged. */
export function withToolMetadata(
	entry: TimelineEntry,
	tool: ToolMetadata | undefined,
): TimelineEntry {
	return tool ? { ...entry, tool } : entry;
}
