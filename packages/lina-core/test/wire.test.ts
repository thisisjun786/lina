import { expect, test } from "bun:test";
import { parseWireClient, parseWireServer } from "../src/wire.ts";

test("ping and pong round-trip bounded session and nonce fields", () => {
	for (const nonce of ["probe-1", "n".repeat(128)]) {
		expect(
			parseWireClient(JSON.stringify({ type: "ping", sessionId: "s1", nonce })),
		).toEqual({ type: "ping", sessionId: "s1", nonce });
		expect(
			parseWireServer(JSON.stringify({ type: "pong", sessionId: "s1", nonce })),
		).toEqual({ type: "pong", sessionId: "s1", nonce });
	}
});

test("ping and pong reject missing, malformed, oversized and extra fields", () => {
	for (const [type, parse] of [
		["ping", parseWireClient],
		["pong", parseWireServer],
	] as const) {
		for (const field of ["sessionId", "nonce"]) {
			for (const value of [
				undefined,
				null,
				0,
				true,
				{},
				[],
				"",
				"x".repeat(129),
			]) {
				expect(
					parse(
						JSON.stringify({
							type,
							sessionId: "s1",
							nonce: "n1",
							[field]: value,
						}),
					),
				).toBeUndefined();
			}
		}
		for (const extra of [{ revision: 0 }, { id: "r1" }, { text: "ignore" }]) {
			expect(
				parse(JSON.stringify({ type, sessionId: "s1", nonce: "n1", ...extra })),
			).toBeUndefined();
		}
		for (const raw of [null, {}, "{", "[]"]) expect(parse(raw)).toBeUndefined();
	}
	expect(
		parseWireClient('{"type":"pong","sessionId":"s1","nonce":"n1"}'),
	).toBeUndefined();
	expect(
		parseWireServer('{"type":"ping","sessionId":"s1","nonce":"n1"}'),
	).toBeUndefined();
});

test("durable commands validate session, cursors and chat limits", () => {
	expect(
		parseWireClient(JSON.stringify({ type: "subscribe", version: 2 })),
	).toEqual({ type: "subscribe", version: 2 });
	expect(
		parseWireClient(
			JSON.stringify({ type: "history", sessionId: "s1", before: 10 }),
		),
	).toEqual({ type: "history", sessionId: "s1", before: 10 });
	expect(
		parseWireClient(
			JSON.stringify({ type: "history", sessionId: "s1", before: -1 }),
		),
	).toBeUndefined();
	expect(
		parseWireClient(JSON.stringify({ type: "chat", id: "r", text: " " })),
	).toBeUndefined();
	expect(
		parseWireClient(
			JSON.stringify({ type: "chat", id: "r", text: "a".repeat(16001) }),
		),
	).toBeUndefined();
});

test("snapshot decoding validates nested ownership and does not forward arbitrary fields", () => {
	const snapshot = {
		version: 2 as const,
		botId: "lina",
		sessionId: "s1",
		revision: 3,
		state: "idle" as const,
		messages: [],
		requests: [],
		hasEarlier: false,
		beforeCursor: null,
	};
	expect(
		parseWireServer(
			JSON.stringify({
				type: "snapshot",
				snapshot,
				credential: "not forwarded",
			}),
		),
	).toEqual({ type: "snapshot", snapshot });
	expect(
		parseWireServer(
			JSON.stringify({
				type: "snapshot",
				snapshot: { ...snapshot, state: "invented" },
			}),
		),
	).toBeUndefined();
	expect(
		parseWireServer(
			JSON.stringify({
				type: "snapshot",
				snapshot: {
					...snapshot,
					requests: [
						{
							id: "r",
							sessionId: "foreign",
							text: "x",
							status: "accepted",
							createdAt: "now",
							updatedAt: "now",
						},
					],
				},
			}),
		),
	).toBeUndefined();
	expect(
		parseWireServer(
			JSON.stringify({
				type: "snapshot",
				snapshot: { ...snapshot, messages: Array(201).fill({}) },
			}),
		),
	).toBeUndefined();
});
