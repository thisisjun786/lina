import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import type { SourceEntryAssociation } from "../../lina-runtime/src/sdk-port.ts";
import { loadCodexJournal } from "../src/identity.ts";
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
	return f;
}

test("managed request ID binds user and own assistant before runtime settlement without text equality", async () => {
	const f = fixture();
	const { session, rpc } = await f.open();
	const runtime = f.runtime(session);
	let policyBeforeSend: string | undefined;
	rpc.hook((frame) => {
		if (frame.method === "turn/start")
			policyBeforeSend =
				f.journal.requestSourcePolicy("request-owned")?.requestId;
		return undefined;
	});
	const done = settled(runtime, "request-owned");
	runtime.submit(
		"request-owned",
		"native fixture deliberately returns different text",
	);
	await rpc.next("turn/start");
	rpc.complete(session.threadId, "my own assistant answer");
	await done;
	expect(policyBeforeSend).toBe("request-owned");
	expect(f.journal.request("request-owned")?.status).toBe("settled");
	expect(f.journal.requestSourcePolicy("request-owned")).toMatchObject({
		scope: "ordinary",
		nativeEpoch: 1,
	});
	const entries = session.history() as Array<{ id: string }>;
	expect(entries).toHaveLength(2);
	for (const entry of entries) {
		expect(session.sourceEntryPolicy?.(entry.id)?.requestId).toBe(
			"request-owned",
		);
		expect(f.journal.sourceEntry(entry.id)).toMatchObject({
			requestStatus: "settled",
			sourcePolicy: { requestId: "request-owned", scope: "ordinary" },
		});
	}
	expect(loadCodexJournal(session.sessionFile)).toContainEqual(
		expect.objectContaining({
			type: "context_run",
			requestId: "request-owned",
		}),
	);
});

test("ordinary policy v3 carries exact recipient and supports world-null composition", () => {
	expect(conversationV3()).toMatchObject({
		version: 3,
		purpose: "conversation",
		worldId: null,
		conversationRecipientId: null,
	});
	expect(conversationV3("world").scopeDigest).not.toBe(
		conversationV3().scopeDigest,
	);
});

test("planned tool disclosure taints only current and later retained episodes across reopen and rotation", async () => {
	const f = fixture();
	f.state.policy = conversationV3("world");
	const extra = {
		contextExposure: (
			source: import("../../lina-runtime/src/context-policy.ts").SessionContextSource,
		) =>
			source.kind === "tool"
				? [
						{
							kind: "disclosed-life" as const,
							sourceId: "permitted-current-projection",
						},
					]
				: [],
		register(host: import("../../lina-runtime/src/host.ts").LinaHost) {
			host.registerTool({
				name: "lina_world_read",
				label: "read",
				description: "synthetic explicit projection",
				parameters: Type.Object({}),
				execute: () => ({
					content: [{ type: "text", text: "fictional-secret" }],
					details: {},
				}),
			});
		},
	};
	let opened = await f.open(extra),
		runtime = f.runtime(opened.session);
	async function run(id: string, recall = false) {
		const done = settled(runtime, id);
		runtime.submit(id, "hi");
		await opened.rpc.next("turn/start");
		if (recall) {
			const response = await opened.tool(
				"lina_world_read",
				opened.rpc.threads.at(-1)?.turns.at(-1)?.id,
			);
			expect(JSON.stringify(response)).toContain("fictional-secret");
			expect(f.journal.requestSourcePolicy(id)?.scope).toBe("mixed");
		}
		opened.rpc.complete(opened.session.threadId);
		await done;
	}
	await run("old-ordinary");
	const old = f.journal.requestSourcePolicy("old-ordinary");
	await run("mixed", true);
	await run("retained-no-recall");
	expect(f.journal.requestSourcePolicy("retained-no-recall")?.scope).toBe(
		"mixed",
	);
	expect(f.journal.requestSourcePolicy("old-ordinary")).toEqual(old);
	const toolReceipt = opened.session
		.contextLineage()
		.find((r) => r.source.kind === "tool");
	expect(toolReceipt?.outcome).toBe("planned");
	runtime.detach();
	await opened.session.close();
	f.reopenJournal();
	opened = await f.open(extra);
	runtime = f.runtime(opened.session);
	await run("reopened-retained");
	expect(f.journal.requestSourcePolicy("reopened-retained")?.scope).toBe(
		"mixed",
	);
	f.state.policy = conversationV3();
	await run("rotated-clean");
	expect(f.journal.requestSourcePolicy("rotated-clean")).toMatchObject({
		scope: "ordinary",
		nativeEpoch: 2,
	});
	expect(f.journal.requestSourcePolicy("mixed")?.scope).toBe("mixed");
	expect(f.journal.requestSourcePolicy("old-ordinary")).toEqual(old);
	expect(
		JSON.stringify(
			opened.rpc.frames.filter((x) => x.method === "thread/start"),
		),
	).not.toContain("fictional-secret");
});

test("early exact items stay unclassified until turn identity, including completion before start acknowledgement", async () => {
	const f = fixture();
	const { session, rpc } = await f.open();
	const runtime = f.runtime(session);
	rpc.hook((frame) => (frame.method === "turn/start" ? "drop" : undefined));
	const done = settled(runtime, "early");
	runtime.submit("early", "hi");
	const start = await rpc.next("turn/start");
	rpc.emit("item/completed", {
		threadId: session.threadId,
		turnId: "early-turn",
		item: {
			id: "u",
			type: "userMessage",
			content: [{ type: "text", text: "hi" }],
		},
	});
	const entryId = "codex-v2:1:early-turn:user:0";
	expect(f.journal.sourceEntry(entryId)?.sourcePolicy).toBeUndefined();
	expect(session.sourceEntryPolicy?.(entryId)).toBeUndefined();
	rpc.emit("turn/completed", {
		threadId: session.threadId,
		turn: { id: "early-turn", status: "completed" },
	});
	rpc.options.stdio.output.write(
		JSON.stringify({ id: start.id, result: { turn: { id: "early-turn" } } }) +
			"\n",
	);
	await done;
	expect(f.journal.sourceEntry(entryId)).toMatchObject({
		sourcePolicy: { requestId: "early" },
		requestStatus: "settled",
	});
});

test("raw source forgery and missing tool/entry turn IDs cannot acquire managed source authority", async () => {
	const f = fixture();
	let calls = 0;
	const opened = await f.open({
		register(host) {
			host.registerTool({
				name: "test",
				label: "test",
				description: "test",
				parameters: Type.Object({}),
				execute() {
					calls++;
					return { content: [], details: {} };
				},
			});
		},
	});
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "owned");
	runtime.submit("owned", "hi");
	await opened.rpc.next("turn/start");
	const response = await opened.tool("test", undefined);
	expect(response.error).toBeDefined();
	expect(calls).toBe(0);
	opened.rpc.emit("item/completed", {
		threadId: opened.session.threadId,
		item: {
			id: "forgery",
			type: "userMessage",
			requestId: "owned",
			sourcePolicy: { scope: "ordinary" },
			content: [{ type: "text", text: "hi" }],
		},
	});
	expect(f.journal.sourceEntry("forgery")?.sourcePolicy).toBeUndefined();
	expect(opened.session.sourceEntryPolicy?.("forgery")).toBeUndefined();
	opened.rpc.complete(opened.session.threadId);
	await done;
});

test("early completion reconciled by turn/started keeps lifecycle start before settlement", async () => {
	const f = fixture(),
		opened = await f.open(),
		runtime = f.runtime(opened.session);
	const lifecycle: string[] = [];
	opened.session.subscribe((event) => {
		if (
			event &&
			typeof event === "object" &&
			"type" in event &&
			(event.type === "agent_start" || event.type === "agent_settled")
		)
			lifecycle.push(event.type);
	});
	opened.rpc.hook((frame) =>
		frame.method === "turn/start" ? "drop" : undefined,
	);
	const done = settled(runtime, "early-started");
	runtime.submit("early-started", "hi");
	const start = await opened.rpc.next("turn/start");
	opened.rpc.emit("item/completed", {
		threadId: opened.session.threadId,
		turnId: "early",
		item: {
			id: "u",
			type: "userMessage",
			content: [{ type: "text", text: "hi" }],
		},
	});
	opened.rpc.emit("turn/completed", {
		threadId: opened.session.threadId,
		turn: { id: "early", status: "completed" },
	});
	opened.rpc.emit("turn/started", {
		threadId: opened.session.threadId,
		turn: { id: "early", status: "inProgress" },
	});
	opened.rpc.options.stdio.output.write(
		JSON.stringify({ id: start.id, result: { turn: { id: "early" } } }) + "\n",
	);
	await done;
	expect(lifecycle).toEqual(["agent_start", "agent_settled"]);
	expect(f.journal.request("early-started")?.status).toBe("settled");
});

test("JSONL source association replays idempotently after a journal write failure", async () => {
	const f = fixture();
	const append = f.sourcePolicy.appendSourceEntry;
	f.sourcePolicy.appendSourceEntry = () => {
		throw Error("synthetic journal outage");
	};
	const { session, rpc } = await f.open();
	const runtime = f.runtime(session);
	const done = settled(runtime, "crash");
	runtime.submit("crash", "hi");
	await rpc.next("turn/start");
	rpc.complete(session.threadId);
	await done;
	expect(f.journal.request("crash")?.status).not.toBe("settled");
	expect(loadCodexJournal(session.sessionFile)).toContainEqual(
		expect.objectContaining({ type: "source_entry" }),
	);
	runtime.detach();
	await session.close();
	f.reopenJournal();
	f.sourcePolicy.appendSourceEntry = append;
	const reopened = await f.open();
	const entries = reopened.session.history() as Array<{ id: string }>;
	for (const entry of entries) {
		expect(reopened.session.sourceEntryPolicy?.(entry.id)?.requestId).toBe(
			"crash",
		);
		expect(f.journal.entry(entry.id)).toBeDefined();
		// The failed request never linked its user while active. Replay preserves
		// the native association without promoting this orphan episode to memory.
		expect(f.journal.sourceEntry(entry.id)?.sourcePolicy).toBeUndefined();
	}
	const sourceRecords = loadCodexJournal(session.sessionFile).filter(
		(r) => (r as { type?: string }).type === "source_entry",
	);
	await reopened.session.close();
	f.reopenJournal();
	await f.open();
	expect(
		loadCodexJournal(session.sessionFile).filter(
			(r) => (r as { type?: string }).type === "source_entry",
		),
	).toEqual(sourceRecords);
});

test("direct unmanaged clients remain unclassified and force clean managed rotation", async () => {
	const f = fixture();
	const { session, rpc } = await f.open();
	const prompt = session.prompt("hi", {
		signal: new AbortController().signal,
		disposition() {},
		rejected() {},
	});
	await rpc.next("turn/start");
	rpc.complete(session.threadId, "legacy-secret");
	await prompt;
	const entries = session.history() as Array<{ id: string }>;
	const runtime = f.runtime(session);
	for (const entry of entries)
		expect(f.journal.sourceEntry(entry.id)?.sourcePolicy).toBeUndefined();
	const done = settled(runtime, "managed");
	runtime.submit("managed", "hi");
	await rpc.next("turn/start");
	rpc.complete(session.threadId);
	await done;
	expect(f.journal.requestSourcePolicy("managed")).toMatchObject({
		scope: "ordinary",
		nativeEpoch: 2,
	});
	expect(
		JSON.stringify(rpc.frames.filter((r) => r.method === "thread/start")),
	).not.toContain("legacy-secret");
});

test("source records reject mismatched bindings on reopen before any native dispatch", async () => {
	const f = fixture();
	const { session, rpc } = await f.open();
	const runtime = f.runtime(session);
	const done = settled(runtime, "valid");
	runtime.submit("valid", "hi");
	await rpc.next("turn/start");
	rpc.complete(session.threadId);
	await done;
	runtime.detach();
	await session.close();
	const lines = readFileSync(session.sessionFile, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line));
	const row = lines.find(
		(row) => row.type === "source_entry",
	) as SourceEntryAssociation & { type: string };
	lines[lines.indexOf(row)] = { ...row, nativeEpoch: 99 };
	writeFileSync(
		session.sessionFile,
		lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
	);
	await expect(f.open()).rejects.toThrow(/source provenance/);
});
