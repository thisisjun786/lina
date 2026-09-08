import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { EngineStore } from "../../lina-memory/src/engine/store.ts";
import { installMemoryQuery } from "../../lina-runtime/src/context/memory-query.ts";
import {
	conversationV3,
	settled,
	sourceFixture,
} from "./source-provenance-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test("installed memory query keeps its frozen proof through native tool completion and RPC delivery", async () => {
	const f = sourceFixture();
	cleanup.push(() => f.close());
	f.state.policy = conversationV3("world");
	const mind = new EngineStore(join(f.root, "mind.sqlite"), f.binding, {
		lookup: (id) => f.journal.sourceEntry(id),
	});
	cleanup.push(() => mind.close());
	let calls = 0;
	let events = 0;
	const opened = await f.open({
		contextExposure(source) {
			if (source.kind === "tool") {
				queueMicrotask(() => {
					f.journal.recordSourceExposure({
						type: "context_exposure",
						version: 1,
						id: "restricted-source",
						nativeEpoch: 1,
						scopeDigest: f.state.policy.scopeDigest,
						source: {
							kind: "tool",
							requestId: "original",
							toolName: "lina_world_read",
							callId: "restriction",
						},
						materials: [
							{ kind: "disclosed-life", sourceId: "restricted-material" },
						],
						outcome: "planned",
					});
					f.journal.extendRequestSource("original", ["restricted-source"]);
				});
			}
			return [];
		},
		register(host) {
			installMemoryQuery(host, mind, f.journal, async (input) => {
				if (++calls === 1) return '{"queries":["topic"]}';
				expect(input).toContain("SYNTHETIC_SECRET");
				return "SYNTHETIC_SECRET";
			});
			host.on("tool_execution_end", (event) => {
				events++;
				expect(event.isError).toBe(false);
				expect(event.result).not.toHaveProperty("beforeDeliver");
				expect(JSON.stringify(event.result)).not.toMatch(
					/sourceProofs|policyDigest/,
				);
			});
		},
	});
	const runtime = f.runtime(opened.session);
	const original = settled(runtime, "original");
	runtime.submit("original", "hi");
	await opened.rpc.next("turn/start");
	opened.rpc.complete(opened.session.threadId, "topic SYNTHETIC_SECRET");
	await original;
	const query = settled(runtime, "query");
	runtime.submit("query", "hi");
	await opened.rpc.next("turn/start");
	const reply = await opened.tool("lina_memory_query", "turn-2", {
		query: "topic?",
	});
	expect(calls).toBe(2);
	expect(events).toBe(1);
	expect(reply.error).toEqual({
		code: -32603,
		message: "Codex request delivery blocked",
	});
	expect(JSON.stringify(reply)).not.toMatch(
		/SYNTHETIC_SECRET|sourceProofs|policyDigest/,
	);
	opened.rpc.complete(opened.session.threadId);
	await query;
});
