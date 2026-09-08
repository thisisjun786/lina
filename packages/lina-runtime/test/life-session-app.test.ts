import { expect, test } from "bun:test";
import { join } from "node:path";
import { createCodexEngine } from "../../lina-codex/src/session.ts";
import { contextRpc } from "../../lina-codex/test/context-policy-rpc.ts";
import {
	settled,
	sourceFixture,
} from "../../lina-codex/test/source-provenance-fixture.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { learnedFixture } from "../../lina-core/test/learned-source-fixture.ts";
import {
	identityPolicy,
	lifeDefinition,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { worldFixture, worldServices } from "./world-fixture.ts";

test.each(["disabled", "native"] as const)(
	"ordinary SessionApp (%s) shares persona, retains fictional provenance and rotates on recall revocation",
	async (memoryBackend) => {
		const f = sourceFixture(),
			world = worldFixture(),
			learned = learnedFixture();
		const agents = new AgentStore(join(f.root, "agents.sqlite"));
		agents.create(learned.profile);
		world.store.create(worldDefinition());
		const def = lifeDefinition();
		def.projection.disclosures = [
			{
				subject: { kind: "world_fact", id: "secret" },
				policy: {
					knowers: ["lina"],
					disclosures: [{ agentId: "lina", recipientId: "owner" }],
					publication: ["owner"],
				},
			},
		];
		world.store.prepareLife(def);
		world.store.setWorldBinding("lina", 0, {
			version: 2,
			worldId: "test-world",
			projectionPolicyRevision: 1,
			conversationRecipientId: "owner",
		});
		let rpc = contextRpc(f.root);
		let app: Awaited<ReturnType<typeof startPersistentApp>> | undefined;
		const observations: string[] = [];
		const open = () =>
			startPersistentApp({
				engine: createCodexEngine({
					models: f.options.models,
					rpc: rpc.options,
					services: {
						...worldServices(),
						async observe(text, signal, beforeDispatch) {
							signal.throwIfAborted();
							beforeDispatch?.();
							observations.push(text);
							return "[]";
						},
					},
				}),
				workspace: f.root,
				stateRoot: join(f.root, "app"),
				agentDir: f.root,
				systemPrompt: "Ordinary assistant",
				botId: "lina",
				port: 0,
				memoryBackend,
				persona: { agents, agentId: "lina" },
				world: () => ({
					store: world.store,
					limits: { maxChars: 12000, maxRecords: 30 },
					identityPolicy,
					assertSourceCurrent() {},
				}),
			});
		try {
			app = await open();
			expect(JSON.stringify(rpc.frames)).toContain("Current shared persona");
			expect(JSON.stringify(rpc.frames)).not.toContain("hidden key");
			const done = settled(app.runtime, "recall");
			app.runtime.submit("recall", "hi");
			await rpc.next("turn/start");
			const thread = rpc.threads.at(-1);
			if (!thread) throw Error("Missing native thread");
			const turn = thread.turns.at(-1);
			if (!turn) throw Error("Missing native turn");
			rpc.emit("item/completed", {
				threadId: thread.id,
				turnId: turn.id,
				item: {
					id: "same-user",
					type: "userMessage",
					content: [{ type: "text", text: "hi" }],
				},
			});
			const id = "world-recall";
			rpc.options.stdio.output.write(
				`${JSON.stringify({ id, method: "item/tool/call", params: { threadId: thread.id, turnId: turn.id, tool: "lina_world_read", callId: id, arguments: {} } })}\n`,
			);
			const reply = await rpc.next(`response:${id}`);
			expect(JSON.stringify(reply)).toContain("hidden key");
			expect(app.runtime.snapshot().state).not.toBe("waiting_approval");
			rpc.complete(thread.id);
			await done;
			expect(app.runtime.store.requestSourcePolicy("recall")?.scope).toBe(
				"mixed",
			);
			await app.stop();
			app = undefined;
			rpc.close();
			rpc = contextRpc(f.root);
			app = await open();
			const retained = settled(app.runtime, "retained");
			app.runtime.submit("retained", "hi");
			await rpc.next("turn/start");
			rpc.complete(String(rpc.threads.at(-1)?.id));
			await retained;
			expect(app.runtime.store.requestSourcePolicy("retained")?.scope).toBe(
				"mixed",
			);
			await app.context.refresh();
			expect(observations).toEqual([]);
			world.store.setWorldBinding("lina", 1, {
				version: 2,
				worldId: "test-world",
				projectionPolicyRevision: 1,
				conversationRecipientId: null,
			});
			const clean = settled(app.runtime, "clean");
			app.runtime.submit("clean", "hi");
			const fresh = await rpc.next("turn/start");
			expect(fresh.params["threadId"]).not.toBe(thread.id);
			expect(JSON.stringify(fresh)).not.toContain("hidden key");
			rpc.complete(String(fresh.params["threadId"]));
			await clean;
			expect(app.runtime.store.requestSourcePolicy("clean")?.scope).toBe(
				"ordinary",
			);
			await app.context.refresh();
			expect(observations).toHaveLength(memoryBackend === "native" ? 1 : 0);
			expect(observations.join("\n")).not.toContain("hidden key");
		} finally {
			await app?.stop();
			rpc.close();
			agents.close();
			world.close();
			learned.close();
			await f.close();
		}
	},
);
