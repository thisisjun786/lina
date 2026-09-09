import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../src/host.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-world-host-"));
	roots.push(root);
	return new CodexHost(root, () => ({ action: "allow" }));
}

function reference(customType: string, content: unknown) {
	return { role: "custom", customType, content, display: false, timestamp: 0 };
}

test("context hooks compose messages in order across async and no-op handlers without mutating input", async () => {
	const host = fixture();
	const signal = new AbortController().signal;
	const user = { role: "user", content: "A user message" };
	const memory = reference(
		"lina-context-reference",
		"Actual conversation history",
	);
	const world = reference("lina-world-reference", "Fictional world setting");
	const original = Object.freeze({
		type: "context",
		messages: Object.freeze([user]),
		marker: "preserved metadata",
	});
	host.asLinaHost().on("context", async (event) => ({
		messages: [memory, ...event.messages],
	}));
	host.asLinaHost().on("context", () => undefined);
	host.asLinaHost().on("context", (event, context) => {
		expect(event).toMatchObject({
			type: "context",
			marker: "preserved metadata",
		});
		expect(event.messages).toEqual([memory, user]);
		expect(context.signal).toBe(signal);
		return { messages: [...event.messages, world] };
	});
	expect(await host.emit("context", original, signal)).toEqual({
		messages: [memory, user, world],
	});
	expect(original.messages).toEqual([user]);
});

test("beforeTurn joins both explicit reference types and filters unrelated or non-text blocks", async () => {
	const host = fixture();
	host
		.asLinaHost()
		.on("before_agent_start", () => ({ systemPrompt: "Authored identity\n" }));
	host.asLinaHost().on("context", (event) => ({
		messages: [
			reference("lina-context-reference", "Existing context"),
			...event.messages,
		],
	}));
	host.asLinaHost().on("context", (event) => ({
		messages: [
			...event.messages,
			reference("lina-world-reference", "Fictional world reference"),
			reference("unrecognized-reference", "must not inject this"),
			reference("lina-world-reference", { text: "not plain text" }),
			reference("lina-context-reference", "Second context block"),
		],
	}));
	expect(
		await host.beforeTurn(
			"User text is not extra reference",
			new AbortController().signal,
		),
	).toEqual({
		systemPrompt: "Authored identity\n",
		context:
			"Existing context\n\nFictional world reference\n\nSecond context block",
	});
});

test("non-context hooks keep original payload and last defined result semantics", async () => {
	const host = fixture();
	const original = { prompt: "user", systemPrompt: "base" };
	host.asLinaHost().on("before_agent_start", () => ({ systemPrompt: "first" }));
	host.asLinaHost().on("before_agent_start", (event) => {
		expect(event).toBe(original);
		return { systemPrompt: "second" };
	});
	host.asLinaHost().on("before_agent_start", () => undefined);
	expect(
		await host.emit(
			"before_agent_start",
			original,
			new AbortController().signal,
		),
	).toEqual({ systemPrompt: "second" });

	const toolCall = { toolCallId: "call", toolName: "example", input: {} };
	host.asLinaHost().on("tool_call", () => ({ block: false }));
	host.asLinaHost().on("tool_call", (event) => {
		expect(event).toBe(toolCall);
		return { block: true, reason: "denied" };
	});
	expect(
		await host.emit("tool_call", toolCall, new AbortController().signal),
	).toEqual({ block: true, reason: "denied" });
});
