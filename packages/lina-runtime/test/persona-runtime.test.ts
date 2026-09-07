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
