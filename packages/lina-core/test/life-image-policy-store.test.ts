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
