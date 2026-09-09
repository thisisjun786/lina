import { expect, test } from "bun:test";
import { WorldAuthoring } from "../src/life/authoring.ts";
import { lifeConfigReadiness } from "../src/life/config.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("authoring describes v3 autonomy without activation and notifies only successful configuration writes", async () => {
	const f = await fleetLifeFixture();
	let service: WorldAuthoring | undefined;
	try {
		const { pack, config } = f.setup();
		let prompt = "";
		const changes: string[] = [];
		service = new WorldAuthoring({
			store: f.app.fleet.life.store,
			authoring: async (input) => {
				prompt = input.systemPrompt;
				return {
					provider: "synthetic",
					model: "author",
					text: JSON.stringify(pack),
				};
			},
			modelSettingsRevision: () => 1,
			agentExists: (id) => !!f.app.fleet.agents.get(id),
			changed: (worldId) => {
				expect(f.app.fleet.life.store.lifeConfig(worldId).revision).toBe(2);
				changes.push(worldId);
			},
		});
		const draft = service.create({
			worldId: pack.worldId,
			authoredText: "Explicit authored source",
		});
		const suggestion = await service.suggest(
			{
				requestId: "v3-prompt",
				draftId: draft.id,
				draftRevision: draft.revision,
				agentId: "lina",
				modelSettingsRevision: 1,
			},
			new AbortController().signal,
		);
		expect(suggestion.status).toBe("succeeded");
		expect(suggestion.result?.draft.pack?.schemaVersion).toBe(3);
		for (const field of [
			"schemaVersion:3",
			"AutonomyDefinition",
			"needWeights",
			"traitWeights",
			"habitWeights",
			"quietWeight",
			"minHabitExperiences",
			"Never invent actual existing agent IDs",
		])
			expect(prompt).toContain(field);
		expect(changes).toEqual([]);
		service.setConfig(pack.worldId, 1, config);
		expect(changes).toEqual([pack.worldId]);
		expect(() => service?.setConfig(pack.worldId, 1, config)).toThrow();
		expect(changes).toEqual([pack.worldId]);
		const manual = {
			...config,
			clock: config.clock ? { ...config.clock, intervalMs: null } : null,
		};
		expect(lifeConfigReadiness(manual)).toMatchObject({
			status: "configured",
			automaticReady: false,
			missing: [],
		});
		expect(
			lifeConfigReadiness({ ...manual, run: { mode: "automatic" } }).missing,
		).toEqual(["clock.intervalMs"]);
	} finally {
		await service?.close();
		await f.close();
	}
});
