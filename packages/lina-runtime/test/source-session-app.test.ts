import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexSessionHeader } from "../../lina-codex/src/identity.ts";
import { createCodexEngine } from "../../lina-codex/src/session.ts";
import { contextRpc } from "../../lina-codex/test/context-policy-rpc.ts";
import {
	settled,
	sourceFixture,
} from "../../lina-codex/test/source-provenance-fixture.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { worldServices } from "./world-fixture.ts";

test("ordinary restart verifies fixed identity before creating the native RPC session", async () => {
	const f = sourceFixture();
	let rpc = contextRpc(f.root);
	const options = {
		engine: createCodexEngine({
			models: f.options.models,
			rpc: rpc.options,
			services: worldServices(),
		}),
		workspace: f.root,
		stateRoot: join(f.root, "app-state"),
		agentDir: f.root,
		systemPrompt: "identity",
		port: 0,
		memoryBackend: "disabled" as const,
	};
	let app: Awaited<ReturnType<typeof startPersistentApp>> | undefined;
	try {
		app = await startPersistentApp(options);
		const file = app.binding.sessionFile;
		await app.stop();
		app = undefined;
		rpc.close();
		rpc = contextRpc(f.root);
		options.engine = createCodexEngine({
			models: f.options.models,
			rpc: rpc.options,
			services: worldServices(),
		});
		const lines = readFileSync(file, "utf8").split("\n"),
			header = JSON.parse(lines[0] ?? "");
		lines[0] = JSON.stringify({ ...header, id: "changed-fixed-identity" });
		writeFileSync(file, lines.join("\n"));
		const before = rpc.frames.length;
		await expect(startPersistentApp(options)).rejects.toThrow(
			"The fixed session ID changed",
		);
		expect(rpc.frames).toHaveLength(before);
	} finally {
		await app?.stop();
		rpc.close();
		await f.close();
	}
});

test("managed ordinary SessionApp native memory learns and recalls with source proof after reopen", async () => {
	const f = sourceFixture();
	const root = mkdtempSync(join(tmpdir(), "work-memory-transport-app-"));
	let rpc = contextRpc(root);
	let app: Awaited<ReturnType<typeof startPersistentApp>> | undefined;
	const prompts: string[] = [];
	const open = () =>
		startPersistentApp({
			engine: createCodexEngine({
				models: f.options.models,
				rpc: rpc.options,
				services: {
					...worldServices(),
					async observe(prompt) {
						prompts.push(prompt);
						const line = prompt
							.split("\n")
							.find((l) => l.startsWith("SOURCE DATA: "));
						const sources = JSON.parse(
							line?.slice("SOURCE DATA: ".length) ?? "[]",
						) as Array<{ entryId: string; role: string; text: string }>;
						const user = sources.find((s) => s.role === "user");
						return JSON.stringify(
							prompts.length === 1 && user
								? [
										{
											subject: "user",
											kind: "preference",
											key: "greeting",
											text: "Uses hi as greeting",
											evidence: "explicit",
											sources: [{ entryId: user.entryId, quote: "hi" }],
										},
									]
								: [],
						);
					},
				},
			}),
			workspace: root,
			stateRoot: join(root, "state"),
			agentDir: root,
			systemPrompt: "Authored identity",
			memoryBackend: "native",
			port: 0,
		});
	try {
		app = await open();
		const done = settled(app.runtime, "ordinary");
		app.runtime.submit("ordinary", "hi");
		await rpc.next("turn/start");
		rpc.complete(String(rpc.threads.at(-1)?.id));
		await done;
		await app.context.refresh();
		if (!(app.memory instanceof CompanionMemory))
			throw Error("Native memory unavailable");
		expect(app.memory.mind.state().records).toMatchObject([
			{ text: "Uses hi as greeting", sourceProofs: expect.any(Array) },
		]);
		expect(app.runtime.store.requestSourcePolicy("ordinary")?.scope).toBe(
			"ordinary",
		);
		expect(
			readCodexSessionHeader(app.binding.sessionFile, root).contextPolicy,
		).toMatchObject({
			version: 3,
			worldId: null,
			conversationRecipientId: null,
		});
		const sessionId = app.binding.sessionId;
		await app.stop();
		app = undefined;
		rpc.close();
		rpc = contextRpc(root);
		app = await open();
		expect(app.binding.sessionId).toBe(sessionId);
		const second = settled(app.runtime, "recall");
		app.runtime.submit("recall", "greeting");
		const frame = await rpc.next("turn/start");
		expect(JSON.stringify(frame.params["additionalContext"])).toContain(
			"Uses hi as greeting",
		);
		rpc.complete(String(rpc.threads.at(-1)?.id));
		await second;
		await app.context.refresh();
		expect(prompts).toHaveLength(2);
	} finally {
		await app?.stop();
		rpc.close();
		await f.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("runtime finalizes managed notes only after durable settlement and recovers pending finalization", async () => {
	const { ContextStore } = await import("../../lina-core/src/context/store.ts");
	const { DurableRuntime } = await import("../src/runtime.ts");
	const f = sourceFixture();
	let context: InstanceType<typeof ContextStore> | undefined;
	try {
		const opened = await f.open();
		const createContext = () =>
			new ContextStore(
				join(f.root, "context.sqlite"),
				f.binding,
				(id) => f.journal.sourceEntry(id),
				{
					lookupRequest(id) {
						const entry = f.journal.request(id)?.entryId;
						return entry ? f.journal.sourceEntry(entry) : undefined;
					},
				},
			);
		context = createContext();
		const statuses: string[] = [];
		let finalize = true;
		const runtime = new DurableRuntime(opened.session, f.journal, f.binding, {
			finalizeRequest(id) {
				statuses.push(f.journal.request(id)?.status ?? "missing");
				if (finalize) context?.finalizeRequest(id);
			},
			recoverPending() {
				context?.recoverPending();
			},
		});
		const done = settled(runtime, "note");
		runtime.submit("note", "hi");
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
		expect(
			context.appendNote("tool-note", "ordinary note", {
				activeRequestId: "note",
			}).status,
		).toBe("pending");
		expect(context.notes()).toEqual([]);
		opened.rpc.complete(opened.session.threadId);
		await done;
		expect(statuses).toEqual(["settled"]);
		expect(context.notes()).toMatchObject([{ text: "ordinary note" }]);
		finalize = false;
		const crash = settled(runtime, "crash-before-finalize");
		runtime.submit("crash-before-finalize", "hi");
		await opened.rpc.next("turn/start");
		opened.rpc.emit("item/completed", {
			threadId: opened.session.threadId,
			turnId: "turn-2",
			item: {
				id: "same-user",
				type: "userMessage",
				content: [{ type: "text", text: "hi" }],
			},
		});
		context.appendNote("tool-note-crash", "recover note", {
			activeRequestId: "crash-before-finalize",
		});
		opened.rpc.complete(opened.session.threadId);
		await crash;
		runtime.detach();
		await opened.session.close();
		context.close();
		f.reopenJournal();
		context = createContext();
		const reopened = await f.open();
		const restored = new DurableRuntime(
			reopened.session,
			f.journal,
			f.binding,
			{
				recoverPending() {
					context?.recoverPending();
				},
			},
		);
		expect(context.notes().map((n) => n.text)).toEqual([
			"ordinary note",
			"recover note",
		]);
		expect(context.recoverPending()).toBe(0);
		restored.detach();
	} finally {
		context?.close();
		await f.close();
	}
});

test("SessionApp status retains working source proof until its serialized RPC response", async () => {
	const f = sourceFixture();
	const rpc = contextRpc(f.root);
	let app: Awaited<ReturnType<typeof startPersistentApp>> | undefined;
	try {
		app = await startPersistentApp({
			engine: createCodexEngine({
				models: f.options.models,
				rpc: rpc.options,
				services: worldServices(),
			}),
			workspace: f.root,
			stateRoot: join(f.root, "app-state"),
			agentDir: f.root,
			systemPrompt: "identity",
			port: 0,
			memoryBackend: "disabled",
			registerTools(host) {
				host.on("tool_execution_end", (event) => {
					if (event.toolName !== "lina_status") return;
					expect(JSON.stringify(event.result)).toContain("SECRET_WORKING");
					queueMicrotask(() => {
						if (!app) throw Error("App unavailable");
						const journal = app.runtime.store;
						const policy = journal.requestSourcePolicy("source");
						if (!policy) throw Error("Source policy unavailable");
						journal.recordSourceExposure({
							type: "context_exposure",
							version: 1,
							id: "status-restriction",
							nativeEpoch: policy.nativeEpoch,
							scopeDigest: policy.scopeDigest,
							source: {
								kind: "tool",
								requestId: "source",
								toolName: "synthetic",
								callId: "restriction",
							},
							materials: [
								{ kind: "disclosed-life", sourceId: "restricted-material" },
							],
							outcome: "planned",
						});
						journal.extendRequestSource("source", ["status-restriction"]);
					});
				});
			},
		});
		const original = settled(app.runtime, "source");
		app.runtime.submit("source", "hi");
		await rpc.next("turn/start");
		const threadId = String(rpc.threads.at(-1)?.id);
		rpc.complete(threadId);
		await original;
		app.contextStore.updateWorking(
			0,
			{ goal: "SECRET_WORKING" },
			{ activeRequestId: "source" },
		);
		app.contextStore.finalizeRequest("source");
		const done = settled(app.runtime, "status");
		app.runtime.submit("status", "hi");
		await rpc.next("turn/start");
		rpc.emit("item/completed", {
			threadId,
			turnId: "turn-2",
			item: {
				id: "same-user",
				type: "userMessage",
				content: [{ type: "text", text: "hi" }],
			},
		});
		rpc.options.stdio.output.write(
			`${JSON.stringify({
				id: "status-response",
				method: "item/tool/call",
				params: {
					threadId,
					turnId: "turn-2",
					tool: "lina_status",
					callId: "status-call",
					arguments: {},
				},
			})}\n`,
		);
		const reply = await rpc.next("response:status-response");
		expect(app.runtime.store.requestSourcePolicy("source")?.scope).toBe(
			"mixed",
		);
		expect(reply.error).toEqual({
			code: -32603,
			message: "Codex request delivery blocked",
		});
		expect(JSON.stringify(reply)).not.toContain("SECRET_WORKING");
		rpc.complete(threadId);
		await done;
	} finally {
		await app?.stop();
		rpc.close();
		await f.close();
	}
});
