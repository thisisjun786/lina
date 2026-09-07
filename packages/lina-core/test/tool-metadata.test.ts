import { describe, expect, it } from "bun:test";
import { TOOL_NAME_MAX_CHARS } from "../src/protocol.ts";
import {
	projectToolMetadata,
	type ToolMetadataRow,
} from "../src/tool-metadata.ts";
import { parseWireServer } from "../src/wire.ts";
import { entry, Fixture } from "./fixture.ts";

const toolRaw = (
	id: string,
	message: Record<string, unknown>,
): Record<string, unknown> => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-09-05T10:00:00.000Z",
	message: {
		role: "toolResult",
		toolCallId: "call-1",
		content: [{ type: "text", text: "output" }],
		...message,
	},
});

/** Shapes SQLite json_extract/json_type would produce for the raw record. */
const projected = (
	native_role: unknown,
	tool_name: unknown,
	tool_error_type: unknown = null,
): ToolMetadataRow => ({ native_role, tool_name, tool_error_type });

describe("tool metadata projection", () => {
	it("derives name and error flag from projected native fields", () => {
		expect(
			projectToolMetadata("tool", projected("toolResult", "read")),
		).toEqual({ name: "read" });
		expect(
			projectToolMetadata("tool", projected("toolResult", "bash", "true")),
		).toEqual({ name: "bash", isError: true });
		expect(
			projectToolMetadata("tool", projected("toolResult", "bash", "false")),
		).toEqual({ name: "bash", isError: false });
		expect(
			projectToolMetadata("tool", projected("toolResult", "bash", null)),
		).toEqual({ name: "bash" });
		expect(
			projectToolMetadata("tool", projected("toolResult", "bash", "text")),
		).toEqual({ name: "bash" });
	});

	it("falls back to no metadata for legacy, foreign-role or malformed fields", () => {
		expect(
			projectToolMetadata("tool", projected("toolResult", null)),
		).toBeUndefined();
		expect(
			projectToolMetadata("tool", projected("toolResult", 7)),
		).toBeUndefined();
		expect(
			projectToolMetadata("tool", projected("toolResult", "")),
		).toBeUndefined();
		expect(
			projectToolMetadata("assistant", projected("toolResult", "read")),
		).toBeUndefined();
		expect(projectToolMetadata("tool", projected(null, null))).toBeUndefined();
		expect(
			projectToolMetadata("tool", projected("assistant", "read")),
		).toBeUndefined();
		expect(
			projectToolMetadata("tool", projected("toolResult", "read", 1)),
		).toEqual({ name: "read" });
	});

	it("bounds unknown tool names", () => {
		const long = "x".repeat(TOOL_NAME_MAX_CHARS + 50);
		expect(projectToolMetadata("tool", projected("toolResult", long))).toEqual({
			name: "x".repeat(TOOL_NAME_MAX_CHARS),
		});
	});
});

describe("durable history and search carry tool metadata", () => {
	it("projects metadata in history pages and literal search while raw stays immutable", () => {
		const fixture = new Fixture();
		try {
			const store = fixture.store();
			const failed = entry("failed", {
				role: "tool",
				text: "output failed",
				raw: toolRaw("failed", { toolName: "bash", isError: true }),
			});
			const legacy = entry("legacy", {
				role: "tool",
				text: "output legacy",
				raw: toolRaw("legacy", {}),
			});
			const empty = entry("empty", {
				role: "tool",
				text: "",
				raw: toolRaw("empty", {
					toolName: "write",
					isError: false,
					content: [],
				}),
			});
			const malformed = entry("malformed", {
				role: "tool",
				text: "output malformed",
				raw: toolRaw("malformed", { toolName: 7, isError: "yes" }),
			});
			const huge = entry("huge", {
				role: "tool",
				text: "x".repeat(40000),
				raw: toolRaw("huge", {
					toolName: "read",
					content: [{ type: "text", text: "x".repeat(40000) }],
				}),
			});
			const reply = entry("reply", { text: "output reply" });
			for (const item of [failed, legacy, empty, malformed, huge, reply])
				store.appendEntry(item);

			const history = store.history().messages;
			expect(history.map((row) => row.entryId)).toEqual([
				"failed",
				"legacy",
				"empty",
				"malformed",
				"huge",
				"reply",
			]);
			expect(history[0]?.tool).toEqual({ name: "bash", isError: true });
			expect(history[1]).not.toHaveProperty("tool");
			expect(history[2]?.tool).toEqual({ name: "write", isError: false });
			expect(history[2]?.text).toBe("");
			expect(history[3]).not.toHaveProperty("tool");
			expect(history[4]).toMatchObject({
				tool: { name: "read" },
				truncated: true,
			});
			expect(history[4]?.text).toHaveLength(4096);
			expect(history[5]).not.toHaveProperty("tool");

			const found = store.search("output").messages;
			expect(found.map((row) => row.entryId)).toEqual([
				"failed",
				"legacy",
				"malformed",
				"reply",
			]);
			expect(found[0]?.tool).toEqual({ name: "bash", isError: true });
			expect(found[1]).not.toHaveProperty("tool");
			expect(found[2]).not.toHaveProperty("tool");
			expect(found[3]).not.toHaveProperty("tool");

			expect(store.entry("failed")?.raw).toEqual(failed.raw);
			expect(store.entry("legacy")?.raw).toEqual(legacy.raw);
			expect(store.entry("malformed")?.raw).toEqual(malformed.raw);
		} finally {
			fixture.close();
		}
	});
});

describe("typed wire tool metadata", () => {
	const base = {
		seq: 1,
		entryId: "e1",
		role: "tool",
		text: "output",
		timestamp: "now",
		truncated: false,
	};
	const frame = (message: Record<string, unknown>) =>
		JSON.stringify({
			type: "history",
			sessionId: "s1",
			revision: 1,
			before: 5,
			page: { messages: [message], hasEarlier: false, beforeCursor: 1 },
		});

	it("preserves valid metadata and omits it for legacy rows", () => {
		const typed = parseWireServer(
			frame({
				...base,
				tool: { name: "bash", isError: true, extra: "dropped" },
			}),
		);
		expect(typed?.type).toBe("history");
		if (typed?.type !== "history") throw new Error("unexpected frame");
		expect(typed.page.messages[0]?.tool).toEqual({
			name: "bash",
			isError: true,
		});
		const plain = parseWireServer(frame({ ...base, tool: { name: "read" } }));
		if (plain?.type !== "history") throw new Error("unexpected frame");
		expect(plain.page.messages[0]?.tool).toEqual({ name: "read" });
		const done = parseWireServer(
			frame({ ...base, tool: { name: "read", isError: false } }),
		);
		if (done?.type !== "history") throw new Error("unexpected frame");
		expect(done.page.messages[0]?.tool).toEqual({
			name: "read",
			isError: false,
		});
		const legacy = parseWireServer(frame(base));
		if (legacy?.type !== "history") throw new Error("unexpected frame");
		expect(legacy.page.messages[0]).not.toHaveProperty("tool");
	});

	it("rejects malformed metadata instead of guessing", () => {
		for (const tool of [
			"read",
			{},
			{ name: "" },
			{ name: 3 },
			{ name: "x".repeat(TOOL_NAME_MAX_CHARS + 1) },
			{ name: "read", isError: "yes" },
			{ name: "read", isError: null },
			["read"],
			null,
		])
			expect(parseWireServer(frame({ ...base, tool }))).toBeUndefined();
		expect(
			parseWireServer(
				frame({ ...base, role: "assistant", tool: { name: "read" } }),
			),
		).toBeUndefined();
	});
});

it("optional metadata cannot break history when raw JSON exceeds SQLite's nesting limit", () => {
	const fixture = new Fixture();
	try {
		const store = fixture.store();
		let nested: unknown = { value: true };
		for (let i = 0; i < 1100; i++) nested = { child: nested };
		const raw = toolRaw("deep", {
			toolName: "read",
			isError: false,
			details: nested,
		});
		store.appendEntry(
			entry("deep", { role: "tool", text: "deep result", raw }),
		);
		const before = JSON.stringify(store.entry("deep")?.raw);
		expect(store.history().messages[0]).toMatchObject({
			entryId: "deep",
			text: "deep result",
		});
		expect(store.history().messages[0]?.tool).toBeUndefined();
		expect(store.search("deep").messages[0]?.entryId).toBe("deep");
		expect(JSON.stringify(store.entry("deep")?.raw)).toBe(before);
	} finally {
		fixture.close();
	}
});
