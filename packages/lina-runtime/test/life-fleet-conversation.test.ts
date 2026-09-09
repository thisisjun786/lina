import { expect, test } from "bun:test";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import type { AppOptions } from "../src/session-app.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { createOrdinaryWorldContext } from "../src/world.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("fleet binds an already opened ordinary app lazily without inventing a world or recall recipient", async () => {
	let input: Omit<AppOptions, "engine"> | undefined;
	const f = await fleetLifeFixture({
		createApp: (options) => {
			input = options;
			return startPersistentApp({ ...options, engine: testSessionEngine() });
		},
	});
	try {
		await f.app.fleet.app("lina");
		expect(input?.world).toBeFunction();
		const world = createOrdinaryWorldContext("lina", () => input?.world?.());
		expect(world.policy().worldId).toBeNull();
		expect(world.growth()).toBeNull();
		f.setup();
		const store = f.app.fleet.life.store;
		if (!(store instanceof WorldStore)) throw Error("Missing store");
		store.setWorldBinding("lina", 0, {
			version: 2,
			worldId: "test-world",
			projectionPolicyRevision: 1,
			conversationRecipientId: null,
		});
		expect(world.policy()).toMatchObject({
			worldId: "test-world",
			conversationRecipientId: null,
		});
		expect(world.growth()?.profileRevision).toBe(
			f.app.fleet.agents.get("lina")?.revision,
		);
	} finally {
		await f.close();
	}
});
