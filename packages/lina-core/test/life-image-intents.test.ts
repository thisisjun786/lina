import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import { avatarPeriodicSource } from "../src/world/image-policy.ts";
import { WorldStore } from "../src/world/store.ts";
import { required } from "./life-fixture.ts";
import {
	imageAvatarPolicy,
	imageStoreFixture,
} from "./life-image-store-fixture.ts";

function prepared() {
	const f = imageStoreFixture();
	const policy = f.store.resolveImageAvatarPolicy(
		"test-world",
		"lina",
		1,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		f.store.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing avatar slot fixture");
	// WorldStore's trusted visual port fixture. Actual AgentStore grants are a separate runtime boundary.
	const visual: FrozenVisualIdentity = {
		agentId: "lina",
		profileRevision: 1,
		visualRevision: 1,
		avatarPolicyRevision: 1,
		anchors: ["blue hair"],
		textIdentity: "Approved identity",
		reference: null,
		grants: [
			{ grantId: "visual-grant", revision: 1, purpose: { kind: "avatar" } },
		],
	};
	return {
		...f,
		input: {
			worldId: "test-world",
			agentId: "lina",
			source,
			visuals: [visual],
			requestKey: null,
		},
	};
}

test("same avatar slot persists one immutable brief before any provider job and survives restart", () => {
	const f = prepared();
	try {
		const first = f.store.freezeImageIntent(f.input);
		expect(first.version).toBe(2);
		expect(first.owner).toEqual({
			kind: "life",
			worldId: "test-world",
			agentId: "lina",
		});
		expect(first.briefDigest).toBe(first.material.digest);
		expect(f.store.freezeImageIntent(f.input)).toEqual(first);
		required(f.input.visuals[0]).anchors = ["new appearance"];
		expect(f.store.freezeImageIntent(f.input)).toEqual(first);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.imageIntent("test-world", first.intentId)).toEqual(first);
			expect(reopened.imageIntents("test-world")).toEqual([first]);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("a non-cadence budget edit fences a new POST but preserves a retained portrait destination", () => {
	const f = prepared();
	try {
		const intent = f.store.freezeImageIntent(f.input);
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "provider"),
		).toBe(true);
		const {
			worldId: _world,
			revision,
			...config
		} = f.store.lifeConfig("test-world");
		f.store.setLifeConfig("test-world", revision, {
			...config,
			usage: {
				windowMs: 1000,
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxImages: 2,
			},
		});
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "provider"),
		).toBe(false);
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "destination"),
		).toBe(true);
		expect(f.store.freezeImageIntent(f.input)).toEqual(intent);
	} finally {
		f.close();
	}
});

test("explicit operation identity conflicts with changed material but cannot reroll an automatic slot", () => {
	const f = prepared();
	try {
		const automatic = f.store.freezeImageIntent(f.input);
		const input = { ...f.input, requestKey: "owner-image" };
		const manual = f.store.freezeImageIntent(input);
		expect(manual.intentId).not.toBe(automatic.intentId);
		expect(f.store.freezeImageIntent(input)).toEqual(manual);
		required(input.visuals[0]).textIdentity = "changed";
		expect(() => f.store.freezeImageIntent(input)).toThrow(/conflict/);
		expect(f.store.imageIntents("test-world")).toHaveLength(2);
	} finally {
		f.close();
	}
});

test("invented avatar slot and foreign source owner reject before intent persistence", () => {
	const f = prepared();
	try {
		const source = f.input.source;
		if (source.kind !== "avatar_wall") throw Error("Wrong slot fixture");
		expect(() =>
			f.store.freezeImageIntent({
				...f.input,
				source: { ...source, slotIndex: 9, dueAtMs: 10000 },
			}),
		).toThrow();
		expect(() =>
			f.store.freezeImageIntent({ ...f.input, agentId: "mira" }),
		).toThrow();
		expect(f.store.imageIntents("test-world")).toEqual([]);
	} finally {
		f.close();
	}
});

test("corrupted persisted brief is rejected on actual WorldStore reopen", () => {
	const f = prepared();
	try {
		f.store.freezeImageIntent(f.input);
		f.store.close();
		const db = new DatabaseSync(f.path);
		db.exec(
			"UPDATE life_image_intents SET intent_json=json_set(intent_json,'$.material.prompt','private injected text')",
		);
		db.close();
		expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
	} finally {
		f.close();
	}
});
