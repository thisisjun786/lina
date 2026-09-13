import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSourceProofs } from "../../lina-core/src/source-policy.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { CompanionMemory } from "../src/context/companion.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { NativePersonaGrowth } from "../src/persona/native-growth.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { nativeEpisode } from "./helpers/native-memory-source.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

let resourceRoot: string;
beforeEach(() => {
	resourceRoot = mkdtempSync(join(tmpdir(), "lina-persona-resources-"));
	mkdirSync(join(resourceRoot, "data", "personas"), { recursive: true });
	// Preserve the real prompt/profiles, not unrelated multi-megabyte avatar assets.
	for (const file of ["app-system-prompt.md", "personas/presets.json"])
		copyFileSync(
			join(process.cwd(), "data", file),
			join(resourceRoot, "data", file),
		);
});
afterEach(() => {
	if (resourceRoot) rmSync(resourceRoot, { recursive: true, force: true });
});

test("Fleet uses persisted personal growth after restart without opening ordinary conversation", async () => {
	let enabled = true;
	let miraSource: Parameters<typeof startPersistentApp>[0]["world"];
	const f = await fleetLifeFixture({
		resourceRoot,
		enginePolicy: () => ({
			...defaultEnginePolicy(),
			memory: { ...defaultEnginePolicy().memory, enabled },
		}),
		createApp: (input) => {
			if (input.botId === "mira") miraSource = input.world;
			return startPersistentApp({
				...input,
				memoryBackend: "native",
				engine: testSessionEngine(),
			});
		},
	});
	try {
		expect(readdirSync(join(f.root, "state", "avatars"))).toEqual([]);
		f.setup(false);
		const app = await f.app.fleet.app("lina");
		if (!(app.memory instanceof CompanionMemory))
			throw Error("Missing nativeowner");
		const memory = app.memory,
			journal = app.runtime.store,
			world = f.app.fleet.life.store;
		if (!(world instanceof WorldStore)) throw Error("Missing world owner");
		world.setWorldBinding("mira", 0, {
			worldId: "test-world",
			projectionPolicyRevision: 1,
		});
		for (const id of ["growth-one", "growth-two"]) {
			nativeEpisode(journal, app.binding, id);
			memory.mind.apply({
				requestId: id,
				expectedRevision: memory.mind.currentRevision(),
				sourceProofs: captureSourceProofs(
					[`${id}-user`, `${id}-assistant`],
					(entry) => journal.sourceEntry(entry),
				),
				observations: [
					{
						subject: "self",
						kind: "interest",
						key: "curiosity",
						text: "PRIVATE_MEMORY_GROWTH",
						evidence: "inferred",
						sources: [
							{ entryId: `${id}-user`, quote: "tea" },
							{ entryId: `${id}-assistant`, quote: "tea" },
						],
					},
				],
			});
		}
		const runner = new NativePersonaGrowth({
			agents: f.app.fleet.agents,
			agentId: "lina",
			source: { mind: memory.mind, lookup: (id) => journal.sourceEntry(id) },
			definition: () => world.lifeDefinition("test-world"),
			policy: defaultEnginePolicy,
			modelRevision: () => f.app.fleet.modelSettings.snapshot().revision,
			interpret: async (text) => {
				const p = JSON.parse(text);
				return JSON.stringify({
					traits: [
						{ axisId: "axis", value: 1, evidenceIds: [p.records[0].id] },
					],
					habits: [],
				});
			},
		});
		await runner.run(new AbortController().signal);
		await f.restart();
		expect(f.app.fleet.opened("lina")).toBeUndefined();
		const step = await f.app.fleet.lifeRuntime.run(
			"test-world",
			"personal-restart",
			1,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		expect(step.source.identity.version).toBe(2);
		if (step.source.identity.version !== 2) throw Error("missingv2");
		expect(
			step.source.identity.profiles.find((p) => p.agentId === "lina")
				?.personalBehavior?.traits,
		).toEqual([{ axisId: "axis", value: 1 }]);
		expect(f.app.fleet.opened("lina")).toBeUndefined();
		expect(
			JSON.stringify(step.models.map((m) => m.prepared.request)),
		).not.toContain("PRIVATE_MEMORY_GROWTH");
		await f.restart();
		expect(f.app.fleet.lifeRuntime.step("test-world", step.id)).toEqual(step);
		enabled = false;
		const disabled = await f.app.fleet.lifeRuntime.run(
			"test-world",
			"disabled-personal",
			1,
			new AbortController().signal,
		);
		if (disabled.source.identity.version !== 2)
			throw Error("missing disabled identity");
		expect(
			disabled.source.identity.profiles.every(
				(p) => p.personalBehavior === null,
			),
		).toBe(true);
		expect(
			f.app.fleet.agents.behavior
				.status("lina")
				.some((job) => job.state === "committed"),
		).toBe(true);
		await f.restart();
		enabled = true;
		renameSync(
			join(f.root, "state", "mind.sqlite"),
			join(f.root, "state", "mind-held.sqlite"),
		);
		// Another participant's unavailable personal evidence must not prevent Mira's conversation.
		const mira = await f.app.fleet.app("mira");
		expect(mira.binding.botId).toBe("mira");
		const current = miraSource?.()?.identityPolicy();
		expect(current?.profiles.some((p) => p.agentId === "mira")).toBe(true);
		await expect(
			f.app.fleet.lifeRuntime.run(
				"test-world",
				"unavailable-personal",
				1,
				new AbortController().signal,
			),
		).rejects.toThrow();
		expect(f.app.fleet.opened("lina")).toBeUndefined();
		expect(f.providerCalls).toBe(0);
		expect(readdirSync(join(f.root, "state", "avatars"))).toEqual([]);
	} finally {
		await f.close();
	}
});
