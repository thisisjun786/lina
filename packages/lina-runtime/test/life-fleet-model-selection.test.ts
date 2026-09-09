import { expect, test } from "bun:test";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

function storeOf(f: Awaited<ReturnType<typeof fleetLifeFixture>>) {
	const store = f.app.fleet.life.store;
	if (!(store instanceof WorldStore)) throw Error("Missing owned world store");
	return store;
}

test("fleet freezes exact profiles on new steps and keeps ordinary conversation settings unchanged", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup(false);
		const store = storeOf(f);
		const beforeConversation = structuredClone(
			f.app.fleet.modelSettings.snapshot(),
		);
		const step = await f.app.fleet.lifeRuntime.run(
			"test-world",
			"frozen-one",
			1,
			new AbortController().signal,
		);
		expect(step.version).toBe(4);
		expect(step.status).toBe("accepted");
		const frozen = step.source.resolvedModels;
		if (!frozen?.director || !frozen.actor) throw Error("missing frozen lanes");
		expect(frozen.director.model).toBe("route/director");
		expect(frozen.actor.model).toBe("route/actor");
		expect(frozen.director.settingsRevision).toBe(beforeConversation.revision);
		const request = f.models[0]?.requests.find(
			(item) => item.lane === "director",
		);
		if (!request || request.version !== 3)
			throw Error("missing frozen request");
		expect(request.selection).toEqual(frozen.director);
		expect(f.app.fleet.modelSettings.snapshot()).toEqual(beforeConversation);
		expect(f.providerCalls).toBe(0);
		const replay = await f.app.fleet.lifeRuntime.run(
			"test-world",
			"frozen-one",
			1,
			new AbortController().signal,
		);
		expect(replay).toEqual(store.lifeStep("test-world", step.id));
	} finally {
		await f.close();
	}
});

test("fleet rejects replay after frozen effort and cap settings change", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup();
		const owned = f.app.fleet.lifeRuntime;
		const first = await owned.run(
			"test-world",
			"frozen-two",
			1,
			new AbortController().signal,
		);
		expect(first.version).toBe(4);
		const current = f.app.fleet.modelSettings.snapshot();
		f.app.fleet.modelSettings.replace(current.revision, {
			profiles: current.profiles.map((profile) =>
				profile.id === "director"
					? { ...profile, reasoning: "high", maxOutputTokens: 16 }
					: {
							id: profile.id,
							provider: profile.provider,
							model: profile.model,
							reasoning: profile.reasoning,
						},
			),
			defaultProfileId: current.defaultProfileId,
			roles: current.roles,
			agentRoles: current.agentRoles,
		});
		await expect(
			owned.run("test-world", "frozen-two", 1, new AbortController().signal),
		).rejects.toThrow(/idempotency conflict|selection changed|model\/settings/);
	} finally {
		await f.close();
	}
});
