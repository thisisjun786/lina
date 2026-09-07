import { expect, test } from "bun:test";
import { SearchModel } from "../../lina-client/src/search-model.ts";

const row = {
	seq: 3,
	entryId: "answer",
	role: "assistant" as const,
	text: "여행",
	timestamp: "now",
	truncated: false,
};
test("searches correlate across query changes, page independently and ignore foreign replies", () => {
	let i = 0;
	const m = new SearchModel(() => String(++i));
	m.connect(true, "s");
	const first = m.search("old"),
		second = m.search("new");
	if (first?.type !== "search" || second?.type !== "search")
		throw Error("missing search");
	const page = { messages: [row], hasEarlier: true, beforeCursor: 3 };
	m.receive({
		type: "search-results",
		sessionId: "s",
		requestId: first.requestId,
		page,
	});
	expect(m.rows).toEqual([]);
	m.receive({
		type: "search-results",
		sessionId: "foreign",
		requestId: second.requestId,
		page,
	});
	expect(m.rows).toEqual([]);
	m.receive({
		type: "search-results",
		sessionId: "s",
		requestId: second.requestId,
		page,
	});
	expect(m.rows).toEqual([row]);
	expect(m.search("new", "older")).toMatchObject({ before: 3 });
	m.fail();
	expect(m.pending).toBeUndefined();
	expect(m.search("new", "newer")).toMatchObject({
		before: Number.MAX_SAFE_INTEGER,
	});
	m.connect(false, "s");
	expect(m.search("new")).toBeUndefined();
	m.connect(true, "different");
	expect(m.rows).toEqual([]);
});
test("original reads stay on the selected result and enforce exact offsets and display bounds", () => {
	const m = new SearchModel(() => "query");
	m.connect(true, "s");
	m.search("여행");
	m.receive({
		type: "search-results",
		sessionId: "s",
		requestId: "query",
		page: { messages: [row], hasEarlier: false, beforeCursor: 3 },
	});
	expect(m.select("missing")).toBeUndefined();
	expect(m.select("answer")).toMatchObject({
		type: "entry",
		entryId: "answer",
		offset: 0,
	});
	m.receive({
		type: "entry-text",
		requestId: "query",
		sessionId: "s",
		entryId: "different",
		offset: 0,
		text: "bad",
		nextOffset: null,
	});
	expect(m.original).toBe("");
	m.receive({
		type: "entry-text",
		requestId: "query",
		sessionId: "s",
		entryId: "answer",
		offset: 0,
		text: "first",
		nextOffset: 5,
	});
	expect(m.original).toBe("first");
	expect(m.more()).toMatchObject({ offset: 5 });
	m.receive({
		type: "entry-text",
		requestId: "query",
		sessionId: "s",
		entryId: "answer",
		offset: 0,
		text: "duplicate",
		nextOffset: 9,
	});
	expect(m.original).toBe("first");
	m.back();
	m.receive({
		type: "entry-text",
		requestId: "query",
		sessionId: "s",
		entryId: "answer",
		offset: 5,
		text: "late",
		nextOffset: null,
	});
	expect(m.selected).toBeUndefined();
});

test("tagged original reads reject a stale read and stop at the display limit", () => {
	let n = 0;
	const m = new SearchModel(() => String(++n));
	m.connect(true, "s");
	m.search("여행");
	m.receive({
		type: "search-results",
		sessionId: "s",
		requestId: "1",
		page: { messages: [row], hasEarlier: false, beforeCursor: 3 },
	});
	const stale = m.select("answer");
	m.back();
	let request = m.select("answer");
	if (stale?.type !== "entry" || request?.type !== "entry")
		throw Error("missing read");
	m.receive({
		type: "entry-text",
		sessionId: "s",
		entryId: "answer",
		requestId: stale.requestId ?? "",
		offset: 0,
		text: "old",
		nextOffset: null,
	});
	expect(m.original).toBe("");
	for (let offset = 0; offset < 65536; offset += 8192) {
		if (request?.type !== "entry") throw Error("missing page");
		m.receive({
			type: "entry-text",
			sessionId: "s",
			entryId: "answer",
			requestId: request.requestId ?? "",
			offset,
			text: "x".repeat(8192),
			nextOffset: offset + 8192,
		});
		request = m.more();
	}
	expect(m.original.length).toBe(65536);
	expect(m.limited).toBe(true);
	expect(m.more()).toBeUndefined();
});
