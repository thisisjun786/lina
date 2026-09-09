import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
	avatarIntentId,
	avatarPeriodicSource,
} from "../src/world/image-policy.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	imageStoreFixture as fixture,
	imageAvatarPolicy as policy,
} from "./life-image-store-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

test("an unprepared legacy world cannot freeze a step-clock portrait as a wall-clock exception", () => {
	const store = new WorldStore(":memory:", () => 1000);
	try {
		store.create(worldDefinition());
		const { worldId, revision, ...empty } = store.lifeConfig("test-world");
		store.setLifeConfig(worldId, revision, {
			...empty,
			avatars: { mode: "automatic", intervalMs: null, maxPerWindow: 1 },
			usage: {
				windowMs: 1000,
				maxInputTokens: 0,
				maxOutputTokens: 0,
				maxImages: 1,
			},
		});
		store.setImageSettings(worldId, 0, {
			version: 1,
			worldVersion: null,
			route: { provider: "synthetic", model: "image" },
			eventRules: [],
			avatarEventRules: [],
			perAuthorCooldownSteps: 0,
			attachMode: "manual",
			maxJobsPerVisit: 1,
			storage: {
				maxActiveJobs: 1,
				maxArchivedJobs: 1,
				maxAssets: 1,
				maxTotalBytes: 10000000,
			},
		});
		const resolved = store.resolveImageAvatarPolicy(worldId, "lina", 1, {
			...policy,
			schedule: { kind: "steps", epochRevision: 0, intervalSteps: 1 },
		});
		const source = avatarPeriodicSource(resolved, 1000, 0);
		if (!source) throw Error("Missing step-clock fixture slot");
		expect(source.kind).toBe("avatar_steps");
		expect(() =>
			store.freezeImageIntent({
				worldId,
				agentId: "lina",
				source,
				visuals: [],
				requestKey: null,
			}),
		).toThrow("Unknown LIFE revision");
	} finally {
		store.close();
	}
});

test("resolved avatar policy preserves original config and cadence through settings edits and file reopen", () => {
	const f = fixture();
	try {
		const first = f.store.resolveImageAvatarPolicy(
			"test-world",
			"lina",
			1,
			policy,
		);
		expect(
			f.store.resolveImageAvatarPolicy("test-world", "lina", 1, policy),
		).toEqual(first);
		const {
			worldId: _w,
			revision,
			...config
		} = f.store.lifeConfig("test-world");
		f.store.setLifeConfig("test-world", revision, {
			...config,
			usage: {
				windowMs: 1000,
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxImages: 6,
			},
		});
		const second = f.store.resolveImageAvatarPolicy("test-world", "lina", 2, {
			...policy,
			applyMode: "manual",
		});
		expect(second.id).not.toBe(first.id);
		expect(second.scheduleKey).toBe(first.scheduleKey);
		const a = avatarPeriodicSource(first, 3500, 0),
			b = avatarPeriodicSource(second, 3500, 0);
		if (!a || !b) throw Error("Missing slots");
		expect(avatarIntentId("test-world", "lina", a)).toBe(
			avatarIntentId("test-world", "lina", b),
		);
		f.store.close();
		const reopened = new WorldStore(f.path);
		try {
			expect(reopened.imageAvatarPolicy("test-world", first.id)).toEqual(first);
			expect(reopened.imageAvatarPolicy("test-world", second.id)).toEqual(
				second,
			);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});
test.each(["config", "digest", "owner"] as const)(
	"resolved policy %s corruption rejects actual reopen",
	(kind) => {
		const f = fixture();
		try {
			f.store.resolveImageAvatarPolicy("test-world", "lina", 1, policy);
			f.store.close();
			const db = new DatabaseSync(f.path);
			try {
				if (kind === "config")
					db.exec(
						"UPDATE life_image_avatar_policies SET policy_json=json_set(policy_json,'$.configRevision',999)",
					);
				if (kind === "digest")
					db.exec("UPDATE life_image_avatar_policies SET digest='bad'");
				if (kind === "owner")
					db.exec("UPDATE life_image_avatar_policies SET policy_id='foreign'");
			} finally {
				db.close();
			}
			expect(() => new WorldStore(f.path).close()).toThrow();
		} finally {
			f.close();
		}
	},
);
