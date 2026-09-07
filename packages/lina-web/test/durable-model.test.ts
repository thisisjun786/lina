import { expect, test } from "bun:test";
import type {
	SessionSnapshot,
	TimelineEntry,
} from "../../lina-core/src/protocol.ts";
import { DurableChatModel } from "../client/durable-model.ts";

const row = (
	seq: number,
	role: "user" | "assistant" = "user",
): TimelineEntry => ({
	seq,
	entryId: `entry-${seq}`,
	role,
	text: `text-${seq}`,
	timestamp: "now",
	truncated: false,
});
const snapshot = (
	messages: TimelineEntry[],
	revision = 1,
): SessionSnapshot => ({
	version: 2,
	botId: "lina",
	sessionId: "fixed",
	revision,
	state: "idle",
	messages,
	requests: [],
	hasEarlier: false,
	beforeCursor: messages[0]?.seq ?? null,
});

test("restored snapshots replace optimistic sends with one canonical native entry", () => {
	const model = new DurableChatModel();
	model.receive({ type: "snapshot", snapshot: snapshot([]) });
	expect(model.send("request", "text-1")).toBe(true);
	const restored = {
		...snapshot([row(1)], 2),
		requests: [
			{
				id: "request",
				sessionId: "fixed",
				text: "text-1",
				status: "accepted" as const,
				createdAt: "now",
				updatedAt: "now",
				entryId: "entry-1",
			},
		],
	};
	model.receive({ type: "snapshot", snapshot: restored });
	model.receive({ type: "snapshot", snapshot: restored });
	expect(model.messages).toHaveLength(1);
	expect(model.pendingId).toBeUndefined();
	expect(model.messages[0]?.status).toBe("saved");
});

test("tentative tool commentary stays invisible and committed answers survive stale events", () => {
	const model = new DurableChatModel();
	model.receive({ type: "snapshot", snapshot: snapshot([row(1)], 2) });
	model.receive({ type: "live-text", sessionId: "fixed", text: "partial" });
	expect(model.messages.map((message) => message.text)).toEqual(["text-1"]);
	model.receive({
		type: "snapshot",
		snapshot: snapshot([row(1), row(2, "assistant")], 3),
	});
	expect(model.messages.map((message) => message.text)).toEqual([
		"text-1",
		"text-2",
	]);
	model.receive({ type: "snapshot", snapshot: snapshot([], 1) });
	model.receive({ type: "live-text", sessionId: "foreign", text: "wrong" });
	expect(model.messages).toHaveLength(2);
});

test("older pages merge in chronological order and expanded text survives snapshots", () => {
	const model = new DurableChatModel();
	model.receive({
		type: "snapshot",
		snapshot: snapshot([{ ...row(2), truncated: true }], 2),
	});
	model.receive({
		type: "history",
		before: 2,
		sessionId: "fixed",
		revision: 2,
		page: { messages: [row(1)], hasEarlier: false, beforeCursor: 1 },
	});
	model.receive({
		type: "entry-text",
		sessionId: "fixed",
		entryId: "entry-2",
		offset: 0,
		text: "original full text",
		nextOffset: null,
	});
	model.receive({
		type: "snapshot",
		snapshot: snapshot([{ ...row(2), truncated: true }], 3),
	});
	expect(model.messages.map((message) => message.text)).toEqual([
		"text-1",
		"original full text",
	]);
});

test("a new bound session replaces old history instead of merging it", () => {
	const model = new DurableChatModel();
	model.receive({ type: "snapshot", snapshot: snapshot([row(1)]) });
	model.receive({
		type: "snapshot",
		snapshot: { ...snapshot([row(2)]), sessionId: "replacement" },
	});
	expect(model.sessionId).toBe("replacement");
	expect(model.messages.map((message) => message.text)).toEqual(["text-2"]);
});

test("expanded text reports the display limit while the server still has more source", () => {
	const model = new DurableChatModel();
	model.receive({
		type: "snapshot",
		snapshot: snapshot([{ ...row(1), truncated: true }]),
	});
	for (let offset = 0; offset < 65536; offset += 8192)
		model.receive({
			type: "entry-text",
			sessionId: "fixed",
			entryId: "entry-1",
			offset,
			text: "x".repeat(8192),
			nextOffset: offset + 8192,
		});
	expect(model.messages[0]?.text).toContain("화면 표시 한도");
});

test("evicted history cannot leave an unreachable gap after a fresh latest snapshot", () => {
	const model = new DurableChatModel();
	const rows = (start: number, count: number) =>
		Array.from({ length: count }, (_, i) => row(start + i));
	model.receive({
		type: "snapshot",
		snapshot: { ...snapshot(rows(901, 100)), hasEarlier: true },
	});
	for (let before = 901; before > 1; before -= 100)
		model.receive({
			type: "history",
			before,
			sessionId: "fixed",
			revision: 1,
			page: {
				messages: rows(before - 100, 100),
				beforeCursor: before - 100,
				hasEarlier: before > 101,
			},
		});
	expect(model.hasNewer).toBe(true);
	model.receive({
		type: "snapshot",
		snapshot: { ...snapshot(rows(902, 100), 2), hasEarlier: true },
	});
	expect(model.messages.map((message) => message.sourceId)).toEqual(
		rows(902, 100).map((entry) => entry.entryId),
	);
	expect(model.beforeCursor).toBe(902);
	expect(model.hasEarlier).toBe(true);
});

test("a delayed older-page reply cannot fill a different visible frontier", () => {
	const model = new DurableChatModel();
	model.receive({
		type: "snapshot",
		snapshot: { ...snapshot([row(100)]), hasEarlier: true },
	});
	model.showLatest();
	model.receive({
		type: "snapshot",
		snapshot: { ...snapshot([row(500)], 2), hasEarlier: true },
	});
	model.receive({
		type: "history",
		sessionId: "fixed",
		revision: 2,
		before: 100,
		page: { messages: [row(99)], hasEarlier: true, beforeCursor: 99 },
	});
	expect(model.messages.map((message) => message.sourceId)).toEqual([
		"entry-500",
	]);
	expect(model.beforeCursor).toBe(500);
});

test("tool records never enter the human conversation even from a legacy snapshot", () => {
	const model = new DurableChatModel();
	model.receive({
		type: "snapshot",
		snapshot: snapshot([
			row(1),
			{ ...row(2), role: "tool", text: "INTERNAL" },
			row(3, "assistant"),
		]),
	});
	expect(model.messages.map((m) => m.text)).toEqual(["text-1", "text-3"]);
	model.receive({
		type: "entry-text",
		sessionId: "fixed",
		entryId: "entry-2",
		offset: 0,
		text: "RAW",
		nextOffset: null,
	});
	expect(model.messages.map((m) => m.text)).toEqual(["text-1", "text-3"]);
});

test("tagged search reads cannot rewind expanded timeline messages", () => {
	const m = new DurableChatModel();
	m.receive({
		type: "snapshot",
		snapshot: snapshot([{ ...row(1, "assistant"), truncated: true }]),
	});
	m.receive({
		type: "entry-text",
		sessionId: "fixed",
		entryId: "entry-1",
		offset: 0,
		text: "a".repeat(8192),
		nextOffset: 8192,
	});
	m.receive({
		type: "entry-text",
		sessionId: "fixed",
		entryId: "entry-1",
		offset: 8192,
		text: "b".repeat(8192),
		nextOffset: 16384,
	});
	m.receive({
		type: "entry-text",
		sessionId: "fixed",
		entryId: "entry-1",
		requestId: "search-read",
		offset: 0,
		text: "a".repeat(8192),
		nextOffset: 8192,
	});
	expect(m.messages[0]?.text.length).toBe(16384);
	expect(m.messages[0]?.nextOffset).toBe(16384);
});
