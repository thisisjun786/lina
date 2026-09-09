import { expect, test } from "bun:test";
import { join } from "node:path";
import { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { SharedPersonaView } from "../../lina-core/src/world/life-types.ts";
import { learnedFixture } from "../../lina-core/test/learned-source-fixture.ts";
import type { ContextServices } from "../src/context/port.ts";
import type { LinaHost } from "../src/host.ts";
import { installPersona } from "../src/persona/hooks.ts";

const growth: SharedPersonaView = {
	version: 1,
	worldId: "world",
	agentId: "lina",
	lifeRevision: 1,
	bindingRevision: 1,
	projectionPolicyRevision: 1,
	profileRevision: 1,
	traits: [{ label: "Sociability", value: 7 }],
	habits: [],
	attitudes: [],
	truncated: false,
};
function fixture(nativeDynamics = false) {
	const f = learnedFixture(),
		agents = new AgentStore(join(f.root, "a.sqlite")),
		conversations = new ConversationStore(join(f.root, "c.sqlite"));
	agents.create(f.profile);
	const handlers = new Map<
		string,
		() => { systemPrompt: string; beforeDeliver?: () => void }
	>();
	let tool:
		| {
				execute: (
					id: string,
					params: { section: string },
				) => Promise<{
					content: { text: string }[];
					beforeDeliver?: () => void;
				}>;
		  }
		| undefined;
	const host = {
		on: (
			name: string,
			fn: () => { systemPrompt: string; beforeDeliver?: () => void },
		) => handlers.set(name, fn),
		registerTool: (t: typeof tool) => {
			tool = t;
		},
	} as unknown as LinaHost;
	let shared = growth;
	const refresh = installPersona(
		host,
		agents,
		"lina",
		"host",
		{
			systemTokens: 0,
			estimateText: (s: string) => s.length,
		} as ContextServices,
		{
			nativeDynamics,
			conversations,
			sourceLookup: f.lookup,
			sharedGrowth: () => shared,
		},
	);
	return {
		...f,
		agents,
		conversations,
		refresh,
		hook: () => {
			const h = handlers.get("before_agent_start");
			if (!h) throw Error("Missing hook");
			return h();
		},
		tool: () => {
			if (!tool) throw Error("Missingtool");
			return tool;
		},
		change: () => {
			shared = {
				...shared,
				lifeRevision: 2,
				traits: [{ label: "Sociability", value: 2 }],
			};
		},
		close: () => {
			agents.close();
			conversations.close();
			f.close();
		},
	};
}
test("ordinary native-memory persona receives current shared behavior and a safe growth tool with final guards", async () => {
	const f = fixture(true);
	try {
		const prompt = f.hook();
		expect(prompt.systemPrompt).toContain('"Sociability","value":7');
		expect(prompt.beforeDeliver).toBeFunction();
		const result = await f.tool().execute("growth", { section: "growth" });
		expect(result.content[0]?.text).toContain("Sociability");
		expect(JSON.stringify(result)).not.toMatch(
			/worldId|cause|evidenceIds|sourceProofs/,
		);
		f.change();
		expect(() => prompt.beforeDeliver?.()).toThrow(/persona|growth|source/i);
		expect(() => result.beforeDeliver?.()).toThrow(/persona|growth|source/i);
		expect(f.refresh()).toContain('"Sociability","value":2');
	} finally {
		f.close();
	}
});
test("legacy learned context is withheld while qualified ordinary preferences learn and are invalidated across final dispatch", () => {
	const f = fixture();
	try {
		f.episode("old");
		f.conversations.observePreferences(
			"lina",
			"old",
			"old-user",
			"tea",
			[{ dimension: "emoji", value: "none", quote: "tea" }],
			() => f.source("old"),
		);
		expect(f.refresh()).not.toContain("이모지를 쓰지 않는다");
		const provenance = f.episode("new");
		f.conversations.observePreferences(
			"lina",
			"new",
			"new-user",
			"tea",
			[{ dimension: "emoji", value: "sparing", quote: "tea" }],
			() => f.source("new"),
			1,
			provenance,
		);
		const prompt = f.hook();
		expect(prompt.systemPrompt).toContain("꼭 어울릴 때만 드물게");
		expect(() => prompt.beforeDeliver?.()).not.toThrow();
		f.revoke("new");
		expect(() => prompt.beforeDeliver?.()).toThrow(/source|provenance/i);
		expect(f.refresh()).not.toContain("꼭 어울릴 때만 드물게");
	} finally {
		f.close();
	}
});
