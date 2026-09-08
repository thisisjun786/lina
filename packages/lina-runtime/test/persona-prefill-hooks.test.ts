import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import type { LinaHost } from "../src/host.ts";
import { installPersona } from "../src/persona/hooks.ts";

test("current authored persona stays verbatim in prefill and settings apply without resetting history", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-prefill-hooks-")),
		agents = new AgentStore(join(root, "agents.sqlite")),
		seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("seed");
	agents.create(seed);
	const handlers = new Map<string, (e: unknown) => unknown>();
	const host = {
		on: (name: string, fn: (e: unknown) => unknown) => handlers.set(name, fn),
		registerTool: () => {},
	} as unknown as LinaHost;
	const services = {
		systemTokens: 0,
		estimateText: (s: string) => s.length,
	} as ContextServices;
	try {
		installPersona(host, agents, seed.id, "BASE POLICY", services);
		const hook = handlers.get("before_agent_start");
		const first = hook?.({ prompt: "안녕?" }) as { systemPrompt: string };
		expect(first.systemPrompt).toContain(seed.voice);
		expect(first.systemPrompt).toContain(seed.appearance);
		expect(services.systemTokens).toBe(first.systemPrompt.length);
		const p = agents.get(seed.id);
		if (!p) throw Error("profile");
		agents.update(seed.id, p.revision, { voice: "VOICE UPDATED NEXT TURN" });
		const next = hook?.({ prompt: "다시 왔어" }) as { systemPrompt: string };
		expect(next.systemPrompt).toContain("VOICE UPDATED NEXT TURN");
		expect(next.systemPrompt).not.toContain(seed.voice);
		expect(next.systemPrompt).toContain("BASE POLICY");
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("native persona growth tool reads the native engine rather than stale legacy dynamics", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-native-growth-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("seed");
	agents.create(seed);
	let tool:
		| {
				execute: (
					...args: unknown[]
				) => Promise<{ content: { text: string }[] }>;
		  }
		| undefined;
	const host = {
		on: () => {},
		registerTool: (t: typeof tool) => {
			tool = t;
		},
	} as unknown as LinaHost;
	const services = {
		systemTokens: 0,
		estimateText: (s: string) => s.length,
	} as ContextServices;
	try {
		installPersona(host, agents, seed.id, "FIXED", services, {
			nativeDynamics: true,
			nativeState: () => ({
				agentId: seed.id,
				revision: 9,
				asOf: 0,
				records: [],
				truncated: false,
			}),
		});
		const result = await tool?.execute("id", { section: "growth" }, undefined);
		expect(result?.content[0]?.text).toContain('"revision":9');
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("native prefill explains asynchronous preference and withdrawal processing without claiming completion", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-native-contract-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("seed");
	agents.create(seed);
	const handlers = new Map<string, () => { systemPrompt: string }>();
	const host = {
		on: (name: string, fn: () => { systemPrompt: string }) =>
			handlers.set(name, fn),
		registerTool: () => {},
	} as unknown as LinaHost;
	const services = {
		systemTokens: 0,
		estimateText: (s: string) => s.length,
	} as ContextServices;
	try {
		installPersona(host, agents, seed.id, "FIXED", services, {
			nativeDynamics: true,
		});
		const prompt = handlers.get("before_agent_start")?.().systemPrompt;
		expect(prompt).toContain("대화가 끝난 뒤");
		expect(prompt).toContain("철회");
		expect(prompt).toContain(seed.voice);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});
