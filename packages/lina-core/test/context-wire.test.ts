import { expect, test } from "bun:test";
import { parseContextClient, parseContextServer } from "../src/context-wire.ts";

test("context commands are exact and scoped", () => {
	expect(
		parseContextClient(
			JSON.stringify({ type: "compact", sessionId: "session" }),
		),
	).toEqual({ type: "compact", sessionId: "session" });
	expect(parseContextClient('{"type":"compact"}')).toBeUndefined();
	expect(
		parseContextClient('{"type":"compact","sessionId":"s","force":true}'),
	).toBeUndefined();
});
test("context snapshots validate every state and bound recalled/working content", () => {
	const state = {
		sessionId: "session",
		epoch: "epoch",
		revision: 1,
		busy: false,
		usage: {
			tokens: 100,
			contextWindow: 10000,
			estimated: true,
			injectionTokens: 50,
			injectionOmitted: false,
		},
		compaction: {
			status: "accepted",
			activeId: "summary",
			sourceCount: 3,
			recoveryNeeded: false,
		},
		working: {
			revision: 0,
			goal: "goal",
			decisions: [],
			openItems: [],
			nextSteps: [],
			sourceEntryIds: [],
		},
		memory: {
			service: "disabled",
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			failed: 0,
			freshness: "unknown",
			recallText: "",
		},
	};
	const parse = () =>
		parseContextServer(JSON.stringify({ type: "context-state", state }));
	expect(parse()).toMatchObject({ state: { busy: false } });
	state.memory.freshness = "remembered";
	expect(parse()).toBeUndefined();
	state.memory.freshness = "unknown";
	state.compaction.status = "made-up";
	expect(parse()).toBeUndefined();
	state.compaction.status = "accepted";
	state.working.goal = "x".repeat(1001);
	expect(parse()).toBeUndefined();
	state.working.goal = "goal";
	state.memory.recallText = "x".repeat(4097);
	expect(parse()).toBeUndefined();
});
