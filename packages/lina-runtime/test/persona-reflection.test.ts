import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { DurableStore } from "../../lina-core/src/store.ts";
import { InactiveMemory } from "../src/context/memory.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import { PersonaReflection } from "../src/persona/reflection.ts";
import { trustNativeFixture } from "./helpers/native-memory-source.ts";

test("preference reset during reflection preserves reset and still applies character mood", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-reflection-test-")),
		binding = {
			version: 1 as const,
			botId: "lina",
			sessionId: "session",
			sessionFile: join(root, "session.jsonl"),
			workspace: root,
		},
		agents = new AgentStore(join(root, "agents.sqlite")),
		conversations = new ConversationStore(join(root, "conversation.sqlite")),
		journal = new DurableStore(join(root, "journal.sqlite"), binding);
	trustNativeFixture(journal, binding);
	const seed = readPresets(process.cwd()).find((p) => p.id === "lina");
	if (!seed) throw Error("missing seed");
	agents.create(seed);
	const memory = new InactiveMemory();
	let calls = 0;
	const called = Promise.withResolvers<void>(),
		release = Promise.withResolvers<string>();
	const services: ContextServices = {
		contextWindow: 96000,
		reserveTokens: 16384,
		systemTokens: 0,
		estimateText: (t) => t.length,
		estimateMessages: () => 0,
		summarize: async () => "",
		prepare: () => {
			throw Error("unused");
		},
		reflect: async () => {
			calls++;
			called.resolve();
			return release.promise;
		},
	};
	const reflection = new PersonaReflection({
		agents,
		conversations,
		agentId: "lina",
		journal,
		services,
		memory,
	});
	try {
		journal.createRequest("r", "이모지는 빼줘");
		journal.appendEntry({
			entryId: "user",
			role: "user",
			text: "이모지는 빼줘",
			timestamp: new Date().toISOString(),
			raw: "{}",
		});
		journal.setRequest("r", "accepted", { entryId: "user" });
		journal.setRequest("r", "settled");
		reflection.settled();
		reflection.settled();
		await called.promise;
		conversations.clearPreferences("lina", 0);
		release.resolve(
			JSON.stringify({
				mood: { label: "반가움", reason: "새로운 인사" },
				communicationPreferences: [
					{ dimension: "emoji", value: "none", quote: "이모지는 빼줘" },
				],
			}),
		);
		await reflection.drain();
		expect(calls).toBe(1);
		expect(conversations.getPreferences("lina").items).toEqual([]);
		expect(agents.dynamics("lina").mood?.label).toBe("반가움");
		expect(agents.get("lina")?.personality).toBe(seed.personality);
		reflection.settled();
		expect(calls).toBe(1);
	} finally {
		await reflection.close();
		await memory.close();
		journal.close();
		agents.close();
		conversations.close();
		rmSync(root, { recursive: true, force: true });
	}
});
