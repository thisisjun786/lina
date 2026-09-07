import { expect, test } from "bun:test";
import { ContextModel } from "../../lina-client/src/context-model.ts";
import { parseServerFrame } from "../../lina-client/src/protocol.ts";
import type { ContextSnapshot } from "../../lina-core/src/context-wire.ts";

const snapshot = (epoch = "one", revision = 2): ContextSnapshot => ({
	sessionId: "s",
	epoch,
	revision,
	busy: false,
	usage: {
		tokens: 1000,
		contextWindow: 100000,
		estimated: true,
		injectionTokens: 0,
		injectionOmitted: false,
	},
	compaction: {
		status: "idle",
		activeId: null,
		sourceCount: 0,
		recoveryNeeded: false,
	},
	working: {
		revision: 0,
		goal: "Goal",
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
});
test("context view rejects foreign/stale data, accepts a restarted epoch and gates commands", () => {
	const model = new ContextModel();
	model.bindSession("s");
	model.connected = true;
	model.receive({ type: "context-state", state: snapshot() });
	expect(model.command("compact")).toEqual({ type: "compact", sessionId: "s" });
	model.receive({
		type: "context-state",
		state: { ...snapshot(), sessionId: "foreign", busy: true },
	});
	expect(model.state?.sessionId).toBe("s");
	model.receive({ type: "context-state", state: snapshot("one", 1) });
	expect(model.state?.revision).toBe(2);
	model.receive({ type: "context-state", state: snapshot("two", 0) });
	expect(model.state?.epoch).toBe("two");
	model.running = true;
	expect(model.command("compact")).toBeUndefined();
	model.disconnect();
	expect(model.command("context-refresh")).toBeUndefined();
});
test("gateway protocol recognizes context errors as section-level frames", () => {
	expect(
		parseServerFrame('{"type":"context-error","message":"Unavailable"}'),
	).toEqual({ type: "context-error", message: "Unavailable" });
	expect(
		parseServerFrame(
			JSON.stringify({ type: "context-state", state: snapshot() }),
		),
	).toMatchObject({ state: { epoch: "one" } });
});
