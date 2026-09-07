import { expect, test } from "bun:test";
import { parseControlClient, parseControlServer } from "../src/control-wire.ts";

test("only scoped bounded decisions and cancellation targets enter the control channel", () => {
	const reply = {
		type: "approval_reply" as const,
		sessionId: "s",
		id: "a",
		inputDigest: "a".repeat(64),
		decision: "allow" as const,
	};
	expect(parseControlClient(JSON.stringify(reply))).toEqual(reply);
	expect(
		parseControlClient(JSON.stringify({ ...reply, decision: "always" })),
	).toBeUndefined();
	expect(
		parseControlClient(JSON.stringify({ ...reply, inputDigest: "wrong" })),
	).toBeUndefined();
	expect(
		parseControlClient(
			JSON.stringify({ type: "cancel", sessionId: "s", requestId: "r" }),
		),
	).toEqual({ type: "cancel", sessionId: "s", requestId: "r" });
});

test("control projections require a cancellation target and validate every state", () => {
	const state = {
		sessionId: "s",
		revision: 1,
		tools: [],
		approvals: [],
		cancelling: false,
		cancelFailed: false,
		cancelRequestId: "r0",
	};
	expect(
		parseControlServer(JSON.stringify({ type: "control-state", state })),
	).toEqual({ type: "control-state", state });
	expect(
		parseControlServer(
			JSON.stringify({
				type: "control-state",
				state: { ...state, cancelRequestId: undefined },
			}),
		),
	).toBeUndefined();
	expect(
		parseControlServer(
			JSON.stringify({
				type: "control-state",
				state: { ...state, tools: [{ state: "done" }] },
			}),
		),
	).toBeUndefined();
	expect(
		parseControlServer(
			JSON.stringify({
				type: "control-state",
				state: { ...state, approvals: [{ id: "a", state: "pending" }] },
			}),
		),
	).toBeUndefined();
});
