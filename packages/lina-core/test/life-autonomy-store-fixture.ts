import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../src/world/store.ts";
import { autonomyPack, autonomySource } from "./life-autonomy-pure-fixture.ts";
import { activateSocialPack } from "./life-social-store-fixture.ts";

export function autonomyStoreFixture(quiet = true) {
	const root = mkdtempSync(join(tmpdir(), "lina-autonomy-store-"));
	const path = join(root, "world.sqlite");
	let now = 1000;
	const clock = () => now;
	const store = new WorldStore(path, clock);
	const pack = autonomyPack();
	if (quiet) {
		pack.autonomy.events = [];
		pack.autonomy.quietWeight = 1;
	}
	activateSocialPack(store, pack);
	const source = autonomySource();
	for (const profile of source.profiles) {
		profile.profile = "Resident of the fictional world";
		profile.appearance = "Synthetic resident appearance";
	}
	const { worldId: _world, revision: _revision, ...config } = source.config;
	store.setLifeConfig(pack.worldId, 0, config);
	const request = {
		worldId: pack.worldId,
		idempotencyKey: "tick-one",
		expectedConfigRevision: 1,
		owner: "test",
		nowMs: now,
		leaseMs: 100,
		identity: source.identity,
		profiles: source.profiles,
		modelSettingsRevision: 1,
	};
	return {
		store,
		path,
		clock,
		request,
		source,
		advance(n: number) {
			now += n;
		},
		close() {
			store.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
