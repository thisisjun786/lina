import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { compilePersona } from "../../lina-core/src/agents/persona.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import type { ContextServices } from "../src/context/port.ts";
import { readPresets } from "../src/fleet/presets.ts";
import { installPersona } from "../src/persona/hooks.ts";

test("Codex persona hooks use current authored identity and exclude appearance lore", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-persona-hook-")),
		agents = new AgentStore(join(root, "agents.sqlite"));
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("missing seed");
	agents.create(seed);
	const services: ContextServices = {
		estimateText: (text) => text.length,
		estimateMessages: (messages) => messages.length,
		systemTokens: 0,
		contextWindow: 48000,
		reserveTokens: 1000,
		summarize: async () => "fixture summary",
		prepare: () => {
			throw Error("native preparation is unused");
		},
	};
	const host = new CodexHost(root, () => ({ action: "allow" }));
	installPersona(
		host.asLinaHost(),
		agents,
		seed.id,
		"Base instructions",
		services,
	);
	try {
		const profile = agents.get(seed.id);
		if (!profile) throw Error("missing profile");
		const text = compilePersona(profile, agents.dynamics(seed.id));
		expect(text).toContain(profile.name);
		expect(
			(await host.beforeTurn("hello", new AbortController().signal))
				.systemPrompt,
		).toContain(profile.name);
		expect(text).not.toContain(profile.appearance);
		const next = agents.update(seed.id, profile.revision, {
			voice: "짧은 해요체",
			interests: ["재즈"],
		});
		expect(compilePersona(next, agents.dynamics(seed.id))).toContain("재즈");
		expect(
			(await host.beforeTurn("again", new AbortController().signal))
				.systemPrompt,
		).toContain("재즈");
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("persona memory mode follows live policy and fences an obsolete prepared prompt", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-persona-policy-"));
	const agents = new AgentStore(join(root, "agents.sqlite"));
	const seed = readPresets(process.cwd())[0];
	if (!seed) throw Error("missing seed");
	agents.create(seed);
	let enabled = true;
	const host = new CodexHost(root, () => ({ action: "allow" }));
	const refresh = installPersona(
		host.asLinaHost(),
		agents,
		seed.id,
		"Base",
		{
			estimateText: (text) => text.length,
			estimateMessages: () => 0,
			systemTokens: 0,
			contextWindow: 48000,
			reserveTokens: 1000,
			summarize: async () => "unused",
			prepare: () => {
				throw Error("unused");
			},
		},
		{
			nativeDynamics: true,
			allowNativeGrowth: () => enabled,
			memoryMode: () => (enabled ? "automatic" : "disabled"),
		},
	);
	try {
		const prepared = refresh.prepare();
		expect(prepared.systemPrompt).toContain(
			"Settled conversation is captured automatically",
		);
		enabled = false;
		expect(() => prepared.beforeDeliver()).toThrow("Memory policy changed");
		const disabled = refresh.prepare();
		expect(disabled.systemPrompt).toContain(
			"Automatic long-term conversation memory is disabled",
		);
		expect(disabled.systemPrompt).not.toContain("[네이티브 기억 처리]");
		enabled = true;
		expect(() => disabled.beforeDeliver()).toThrow("Memory policy changed");
		expect(refresh()).toContain(
			"Settled conversation is captured automatically",
		);
	} finally {
		agents.close();
		rmSync(root, { recursive: true, force: true });
	}
});
