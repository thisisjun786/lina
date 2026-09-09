import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import type {
	LinaHost,
	SessionContextSource,
} from "../../lina-runtime/src/host.ts";
import {
	conversationV3,
	settled,
	sourceFixture,
} from "./source-provenance-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
function fixture() {
	const f = sourceFixture();
	cleanups.push(() => f.close());
	f.state.policy = conversationV3("world");
	return f;
}
const disclosure = {
	contextExposure: (source: SessionContextSource) =>
		source.kind === "tool"
			? [{ kind: "disclosed-life" as const, sourceId: "allowed-projection" }]
			: [],
	register(host: LinaHost) {
		host.registerTool({
			name: "lina_world_read",
			description: "Synthetic projection",
			label: "read",
			parameters: Type.Object({}),
			execute: () => ({
				content: [{ type: "text", text: "FICTION-SECRET" }],
				details: {},
			}),
		});
	},
};

test("midturn exposure updates associated user before response bytes; lost acknowledgement remains mixed on recovery", async () => {
	const f = fixture();
	const opened = await f.open(disclosure);
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "lost-tool-ack");
	runtime.submit("lost-tool-ack", "hi");
	await opened.rpc.next("turn/start");
	opened.rpc.emit("item/completed", {
		threadId: opened.session.threadId,
		turnId: "turn-1",
		item: {
			id: "same-user",
			type: "userMessage",
			content: [{ type: "text", text: "hi" }],
		},
	});
	const entryId = f.journal.request("lost-tool-ack")?.entryId;
	opened.rpc.emit("item/completed", {
		threadId: opened.session.threadId,
		turnId: "turn-1",
		item: { id: "tool-item", type: "dynamicToolCall", tool: "lina_world_read" },
	});
	const toolEntryId = "codex-v2:1:turn-1:toolResult:0";
	expect(f.journal.sourceEntry(toolEntryId)).toMatchObject({
		role: "tool",
		sourcePolicy: { requestId: "lost-tool-ack" },
	});
	expect(entryId).toBeDefined();
	expect(f.journal.sourceEntry(entryId ?? "")?.sourcePolicy?.scope).toBe(
		"ordinary",
	);
	let observedBeforeBytes = false;
	opened.rpc.options.stdio.input.on("data", (chunk: Buffer) => {
		if (!chunk.toString().includes("FICTION-SECRET")) return;
		observedBeforeBytes =
			f.journal.sourceEntry(entryId ?? "")?.sourcePolicy?.scope === "mixed" &&
			f.journal.sourceEntry(toolEntryId)?.sourcePolicy?.scope === "mixed";
		opened.rpc.disconnect();
	});
	const reply = await opened.tool("lina_world_read", "turn-1");
	await done;
	expect(JSON.stringify(reply)).toContain("FICTION-SECRET");
	expect(observedBeforeBytes).toBe(true);
	expect(f.journal.request("lost-tool-ack")?.status).toBe("interrupted");
	opened.rpc.complete(opened.session.threadId);
	runtime.detach();
	await opened.session.close();
	f.reopenJournal();
	const reopened = await f.open(disclosure);
	const next = f.runtime(reopened.session);
	const nextDone = settled(next, "after-unknown");
	next.submit("after-unknown", "hi");
	await reopened.rpc.next("turn/start");
	reopened.rpc.complete(reopened.session.threadId);
	await nextDone;
	expect(f.journal.requestSourcePolicy("after-unknown")?.scope).toBe("mixed");
	expect(f.journal.requestSourcePolicy("lost-tool-ack")?.scope).toBe("mixed");
});

test("journal exposure failure fences response and settlement; replay repairs restriction before new dispatch", async () => {
	const f = fixture();
	const opened = await f.open(disclosure);
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "sink-failed");
	runtime.submit("sink-failed", "hi");
	await opened.rpc.next("turn/start");
	const original = f.sourcePolicy.extendRequestSource;
	f.sourcePolicy.extendRequestSource = () => {
		throw Error("synthetic exposure journal outage");
	};
	const reply = await opened.tool("lina_world_read", "turn-1");
	await done;
	expect(JSON.stringify(reply)).not.toContain("FICTION-SECRET");
	expect(reply.error).toBeDefined();
	expect(f.journal.request("sink-failed")?.status).not.toBe("settled");
	opened.rpc.complete(opened.session.threadId);
	runtime.detach();
	await opened.session.close();
	f.sourcePolicy.extendRequestSource = original;
	f.reopenJournal();
	await f.open(disclosure);
	expect(f.journal.requestSourcePolicy("sink-failed")?.scope).toBe("mixed");
});

test("source begin failure dispatches no native turn and replays the missing journal origin", async () => {
	const f = fixture();
	const original = f.sourcePolicy.registerRequestSource;
	f.sourcePolicy.registerRequestSource = () => {
		throw Error("synthetic begin outage");
	};
	const opened = await f.open();
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "begin-failed");
	runtime.submit("begin-failed", "hi");
	await done;
	expect(opened.rpc.frames.some((r) => r.method === "turn/start")).toBe(false);
	expect(f.journal.requestSourcePolicy("begin-failed")).toBeUndefined();
	runtime.detach();
	await opened.session.close();
	f.sourcePolicy.registerRequestSource = original;
	f.reopenJournal();
	await f.open();
	expect(f.journal.requestSourcePolicy("begin-failed")?.scope).toBe("ordinary");
	expect(f.journal.request("begin-failed")?.status).toBe("rejected");
});

test("growth-only material remains ordinary; LIFE purpose stays life even with no disclosure", async () => {
	const f = fixture();
	const opened = await f.open({
		contextExposure: () => [{ kind: "shared-growth", sourceId: "safe-trait" }],
	});
	let runtime = f.runtime(opened.session);
	const done = settled(runtime, "growth-only");
	runtime.submit("growth-only", "hi");
	await opened.rpc.next("turn/start");
	opened.rpc.complete(opened.session.threadId);
	await done;
	expect(f.journal.requestSourcePolicy("growth-only")).toMatchObject({
		scope: "ordinary",
		materialKinds: ["shared-growth"],
	});
	runtime.detach();
	await opened.session.close();
	const { createSessionContextPolicy } = await import(
		"../../lina-runtime/src/context-policy.ts"
	);
	f.state.policy = createSessionContextPolicy({
		version: 1,
		purpose: "life",
		agentId: "mina",
		worldId: "world",
		bindingRevision: 1,
		disclosureRevision: 1,
		sourcePolicyVersion: 1,
	});
	const life = await f.open();
	runtime = f.runtime(life.session);
	const lifeDone = settled(runtime, "life-purpose");
	runtime.submit("life-purpose", "hi");
	await life.rpc.next("turn/start");
	life.rpc.complete(life.session.threadId);
	await lifeDone;
	expect(f.journal.requestSourcePolicy("life-purpose")).toMatchObject({
		scope: "life",
		materialKinds: [],
	});
});
