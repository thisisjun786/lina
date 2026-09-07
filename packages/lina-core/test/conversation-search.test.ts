import { expect, test } from "bun:test";
import { parseWireClient, parseWireServer } from "../src/wire.ts";
import { Fixture } from "./fixture.ts";

test("human search pages through original history without tool/commentary leakage", () => {
	const f = new Fixture(),
		s = f.store();
	try {
		for (let i = 1; i <= 26; i++)
			s.appendEntry({
				entryId: `u${i}`,
				role: "user",
				text: `여행_100% ${i}`,
				timestamp: "2026-09-06T00:00:00Z",
				raw: {},
			});
		for (const [id, role, raw] of [
			["tool", "tool", {}],
			["comment", "assistant", { message: { stopReason: "toolUse" } }],
		] as const)
			s.appendEntry({
				entryId: id,
				role,
				text: "여행_100%",
				timestamp: "now",
				raw,
			});
		const before = s.revision(),
			page = s.conversationSearch("여행_100%");
		expect(page.messages).toHaveLength(20);
		expect(page.hasEarlier).toBe(true);
		expect(page.messages[0]?.entryId).toBe("u7");
		const older = s.conversationSearch("여행_100%", {
			before: page.beforeCursor ?? 0,
		});
		expect(older.messages.map((x) => x.entryId)).toEqual([
			"u1",
			"u2",
			"u3",
			"u4",
			"u5",
			"u6",
		]);
		expect(older.hasEarlier).toBe(false);
		expect(s.conversationSearch("여행X100").messages).toEqual([]);
		expect(s.search("여행_100%").messages.some((x) => x.role === "tool")).toBe(
			true,
		);
		expect(s.revision()).toBe(before);
	} finally {
		f.close();
	}
});
test("search wire validates query, cursor, correlation and roundtrips results", () => {
	const c = {
		type: "search" as const,
		sessionId: "s",
		requestId: "q",
		query: "기억",
		before: 100,
	};
	expect(parseWireClient(JSON.stringify(c))).toEqual(c);
	for (const patch of [
		{ query: "" },
		{ query: " " },
		{ query: "x".repeat(513) },
		{ before: 0 },
		{ before: -1 },
		{ requestId: "" },
		{ extra: true },
	])
		expect(parseWireClient(JSON.stringify({ ...c, ...patch }))).toBeUndefined();
	const r = {
		type: "search-results" as const,
		sessionId: "s",
		requestId: "q",
		page: { messages: [], hasEarlier: false, beforeCursor: null },
	};
	expect(parseWireServer(JSON.stringify(r))).toEqual(r);
});

test("original search reads carry an optional correlation ID without changing legacy reads", () => {
	const request = {
		type: "entry" as const,
		sessionId: "s",
		entryId: "e",
		offset: 0,
		requestId: "read",
	};
	expect(parseWireClient(JSON.stringify(request))).toEqual(request);
	const reply = {
		type: "entry-text" as const,
		sessionId: "s",
		entryId: "e",
		offset: 0,
		text: "answer",
		nextOffset: null,
		requestId: "read",
	};
	expect(parseWireServer(JSON.stringify(reply))).toEqual(reply);
	expect(
		parseWireClient(JSON.stringify({ ...request, requestId: "" })),
	).toBeUndefined();
	expect(
		parseWireServer(JSON.stringify({ ...reply, requestId: 42 })),
	).toBeUndefined();
});
