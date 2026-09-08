import type { AvatarPolicy } from "../src/agents/visual.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

export const imageAvatarPolicy: AvatarPolicy = {
	worldId: "test-world",
	applyMode: "automatic",
	whilePinned: "candidate",
	schedule: { kind: "wall", epochMs: 1000 },
	eventFamilyIds: [],
};
export function imageStoreFixture() {
	const f = autonomyStoreFixture();
	const {
		worldId: _world,
		revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", revision, {
		...config,
		avatars: { mode: "automatic", intervalMs: 1000, maxPerWindow: 3 },
	});
	f.store.setImageSettings("test-world", 0, {
		version: 1,
		worldVersion: 1,
		route: { provider: "synthetic", model: "image" },
		eventRules: [],
		avatarEventRules: [],
		perAuthorCooldownSteps: 0,
		attachMode: "manual",
		maxJobsPerVisit: 1,
		storage: {
			maxActiveJobs: 4,
			maxArchivedJobs: 10,
			maxAssets: 10,
			maxTotalBytes: 10_000_000,
		},
	});
	return f;
}
