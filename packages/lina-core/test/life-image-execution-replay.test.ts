import { expect, test } from "bun:test";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import { avatarPeriodicSource } from "../src/world/image-policy.ts";
import { imageStoreFixture } from "./life-image-store-fixture.ts";

test("prepare replays its original route and attempt after image settings change", () => {
	const f = imageStoreFixture();
	try {
		const source = f.store.resolveImageAvatarPolicy("test-world", "lina", 1, {
			worldId: "test-world",
			applyMode: "automatic",
			whilePinned: "candidate",
			schedule: { kind: "wall", epochMs: 1000 },
			eventFamilyIds: [],
		});
		const slot = avatarPeriodicSource(
			source,
			f.clock(),
			f.store.lifeSnapshot("test-world").revision,
		);
		if (!slot) throw Error("Missing avatar source");
		const visual: FrozenVisualIdentity = {
			agentId: "lina",
			profileRevision: 1,
			visualRevision: 1,
			avatarPolicyRevision: 1,
			anchors: ["blue hair"],
			textIdentity: "Approved identity",
			reference: null,
			grants: [{ grantId: "grant", revision: 1, purpose: { kind: "avatar" } }],
		};
		const intent = f.store.freezeImageIntent({
			worldId: "test-world",
			agentId: "lina",
			source: slot,
			visuals: [visual],
			requestKey: null,
		});
		const original = f.store.prepareImageAttempt(
			"test-world",
			intent.intentId,
			"same-request",
		);
		const settings = f.store.imageSettings("test-world");
		if (!settings) throw Error("Missing image settings");
		const { worldId: _worldId, revision, ...input } = settings;
		f.store.setImageSettings("test-world", revision, {
			...input,
			route: { provider: "changed-provider", model: "changed-model" },
		});
		const replay = f.store.prepareImageAttempt(
			"test-world",
			intent.intentId,
			"same-request",
		);
		expect(replay).toEqual(original);
		expect(replay.route).toEqual({
			provider: "synthetic",
			model: "image",
			settingsRevision: 1,
		});
	} finally {
		f.close();
	}
});
