import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { TaskManager } from "../../lina-codex/src/tasks.ts";
import { FakeCodexRpc } from "../../lina-codex/test/task-fake-rpc.test.ts";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { resourceMemoryContext } from "../src/resources/context.ts";
import { resourceTaskConsumer } from "../src/resources/task-consumer.ts";
import { installResourceTools } from "../src/resources/tools.ts";

const scopeForAgent = (id: string) => ({
	principalId: `agent:${id}`,
	agentId: id,
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
});
test("Lina A writes search memory; B and taskless Codex read shared attribution without a task", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-shared-consumers-")),
		store = new ResourceStore(root, {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		});
	try {
		const a = new CodexHost(root, () => ({ action: "allow" }));
		installResourceTools(a.asLinaHost(), {
			store,
			scope: () => scopeForAgent("a"),
		});
		const written = await a.invokeTool(
			"lina_resource_put",
			"put",
			{
				operationId: "search",
				kind: "document",
				title: "Found source",
				visibility: "shared",
				text: "Paper is portable",
				deriveMemory: true,
				activityKind: "search",
			},
			new AbortController().signal,
		);
		expect(written.success).toBe(true);
		const r = store.list(scopeForAgent("a")).items[0];
		if (!r) throw Error("missingresource");
		const j = store.memories.jobs(scopeForAgent("a"), r.id)[0];
		if (!j) throw Error("missingcapture");
		store.memories.complete(
			scopeForAgent("a"),
			store.memories.prepare(scopeForAgent("a"), j.id, "Paper is portable"),
			[{ kind: "observation", text: "Paper is portable", quote: "portable" }],
		);
		const b = new CodexHost(root, () => ({ action: "allow" }));
		installResourceTools(b.asLinaHost(), {
			store,
			scope: () => scopeForAgent("b"),
		});
		const result = await b.invokeTool(
			"lina_resource_memory_read",
			"b",
			{ id: r.id },
			new AbortController().signal,
		);
		expect(result.success).toBe(true);
		expect(JSON.stringify(result)).toContain("not personal lived experience");
		const consumer = resourceTaskConsumer({
			root,
			store,
			scopeForAgent,
			sharedScope: () => ({
				principalId: "external",
				agentId: null,
				allowedVisibilities: ["shared"],
			}),
		});
		const shared = await consumer(
			"lina_resource_memory_read",
			"external",
			{ id: r.id },
			new AbortController().signal,
		);
		expect(shared.success).toBe(true);
		expect(JSON.stringify(shared)).toContain("portable");
		const frame = resourceMemoryContext(store, () => scopeForAgent("b"), r.id);
		store.update(scopeForAgent("a"), {
			id: r.id,
			operationId: "private",
			expectedRevision: 1,
			visibility: "private",
		});
		expect(() => frame.assertCurrent()).toThrow();
		expect(
			(
				await consumer(
					"lina_resource_memory_read",
					"denied",
					{ id: r.id },
					new AbortController().signal,
				)
			).success,
		).toBe(false);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("TaskManager RPC consumes actual scoped resource tool and rejects the previous owner after handover", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-shared-rpc-")),
		store = new ResourceStore(root, {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		});
	const rpc = new FakeCodexRpc(),
		consumer = resourceTaskConsumer({
			root,
			store,
			scopeForAgent,
			sharedScope: () => ({
				principalId: "external",
				agentId: null,
				allowedVisibilities: ["shared"],
			}),
		});
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>(),
		responded = Promise.withResolvers<void>();
	const original = rpc.respond.bind(rpc);
	rpc.respond = async (id, result) => {
		await original(id, result);
		responded.resolve();
	};
	const manager = new TaskManager({
		path: join(root, "tasks.sqlite"),
		rpc,
		dynamicTools: [
			{
				type: "function",
				name: "lina_resource_read",
				description: "Read",
				inputSchema: {
					type: "object",
					properties: { id: { type: "string" } },
					required: ["id"],
					additionalProperties: false,
				},
			},
		],
		executeTool: async (...args) => {
			const result = await consumer(...args);
			expect(JSON.stringify(result)).toContain("PRIVATE_RESOURCE");
			entered.resolve();
			await release.promise;
			return result;
		},
	});
	try {
		const r = store.create(scopeForAgent("a"), {
			operationId: "private",
			kind: "document",
			title: "Secret",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("PRIVATE_RESOURCE"),
		});
		const task = await manager.create({
			ownerAgentId: "a",
			title: "Read notes",
			cwd: root,
			prompt: "Read",
			requestId: "task",
		});
		rpc.emitRequest({
			id: "read",
			method: "item/tool/call",
			params: {
				threadId: task.threadId,
				tool: "lina_resource_read",
				callId: "call",
				arguments: { id: r.id },
			},
		});
		await entered.promise;
		await manager.handover(task.id, {
			ownerAgentId: "b",
			expectedRevision: task.revision,
		});
		release.resolve();
		await responded.promise;
		expect(JSON.stringify(rpc.responses)).not.toContain("PRIVATE_RESOURCE");
		expect(JSON.stringify(rpc.responses)).toContain('"success":false');
	} finally {
		release.resolve();
		await manager.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("model memory context keeps useful content instead of internal ledger hashes", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-memory-payload-")),
		store = new ResourceStore(root, {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		});
	try {
		const scope = scopeForAgent("a"),
			r = store.create(scope, {
				operationId: "d",
				kind: "document",
				title: "Notes",
				visibility: "shared",
				mediaType: "text/plain",
				bytes: new TextEncoder().encode("Evidence"),
				deriveMemory: true,
			});
		const j = store.memories.jobs(scope, r.id)[0];
		if (!j) throw Error("nojob");
		store.memories.complete(
			scope,
			store.memories.prepare(scope, j.id, "Evidence"),
			Array.from({ length: 16 }, (_, i) => ({
				kind: "observation",
				text: `Fact ${i}`,
				quote: "Evidence",
			})),
		);
		const frame = resourceMemoryContext(store, () => scope, r.id);
		expect(frame.value.memories).toHaveLength(16);
		expect(JSON.stringify(frame.value)).not.toContain("fingerprint");
		expect(JSON.stringify(frame.value)).not.toContain("inputHash");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
