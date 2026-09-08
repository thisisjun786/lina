import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import { avatarPeriodicSource } from "../src/world/image-policy.ts";
import { WorldStore } from "../src/world/store.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";
import {
	imageAvatarPolicy,
	imageStoreFixture,
} from "./life-image-store-fixture.ts";

type HistoricalSourceProbe = {
	resolveHistoricalImageSource(input: unknown): unknown;
};

const bounds = {
	outputBytes: 100,
	metadataBytes: 16_384,
	manifestBytes: 16_384,
};

function prepared() {
	const f = imageStoreFixture();
	const {
		worldId: _world,
		revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", revision, {
		...config,
		avatars: { mode: "automatic", intervalMs: 1000, maxPerWindow: 16 },
		usage: {
			windowMs: 1000,
			maxImages: 16,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const settings = f.store.imageSettings("test-world");
	if (!settings) throw Error("Missing image settings fixture");
	const {
		worldId: _settingsWorld,
		revision: settingsRevision,
		...settingsInput
	} = settings;
	f.store.setImageSettings("test-world", settingsRevision, {
		...settingsInput,
		storage: {
			maxActiveJobs: 16,
			maxArchivedJobs: 16,
			maxAssets: 16,
			maxTotalBytes: 10_000_000,
		},
	});
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
	const intent = f.store.freezeImageIntent({
		worldId: "test-world",
		agentId: "lina",
		source,
		visuals: [visual],
		requestKey: null,
	});
	return { ...f, intent };
}

function failedAttempt(
	f: ReturnType<typeof prepared>,
	previousAttemptId: string | null,
	requestKey: string,
) {
	const attempt = previousAttemptId
		? f.store.retryImageAttempt(
				"test-world",
				f.intent.intentId,
				previousAttemptId,
				requestKey,
			)
		: f.store.prepareImageAttempt("test-world", f.intent.intentId, requestKey);
	const jobId = randomUUID();
	f.store.linkImageAttempt("test-world", attempt.attemptId, jobId);
	f.store.reserveImageAttempt("test-world", attempt.attemptId, bounds);
	f.store.dispatchImageAttempt("test-world", attempt.attemptId);
	f.store.observeImageAttempt("test-world", attempt.attemptId, {
		jobId,
		state: "failed",
		endpoint: "http://127.0.0.1:43127",
		runtimeVersion: "3.14.0",
		resultFilename: null,
		artifact: null,
		error: "Synthetic terminal failure",
	});
	f.store.settleImageAttempt("test-world", attempt.attemptId, {
		kind: "failed",
	});
	return attempt;
}

test("one transaction resolves an immutable historical source once for all attempts", () => {
	const f = prepared();
	try {
		let previousAttemptId: string | null = null;
		for (let index = 0; index < 4; index++) {
			const attempt = failedAttempt(f, previousAttemptId, `attempt-${index}`);
			previousAttemptId = attempt.attemptId;
		}
		const probe = f.store as unknown as HistoricalSourceProbe;
		const original = probe.resolveHistoricalImageSource.bind(f.store);
		let calls = 0;
		probe.resolveHistoricalImageSource = (input) => {
			calls++;
			return original(input);
		};
		expect(f.store.imageAttempts("test-world")).toHaveLength(4);
		expect(calls).toBe(1);
		calls = 0;
		expect(f.store.imageAttempts("test-world")).toHaveLength(4);
		expect(calls).toBe(1);
	} finally {
		f.close();
	}
});

test("historical parsing does not preserve current authority and corruption rejects actual reopen", () => {
	const f = prepared();
	try {
		expect(
			f.store.imageIntentAllowed("test-world", f.intent.intentId, "provider"),
		).toBe(true);
		f.store.close();
		const db = new DatabaseSync(f.path);
		db.exec(
			"UPDATE life_image_intents SET intent_json=json_set(intent_json,'$.createdLifeRevision',999)",
		);
		db.close();
		expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
	} finally {
		f.close();
	}
	const published = publishedImageFixture();
	try {
		const {
			worldId: _world,
			revision,
			...config
		} = published.store.lifeConfig("test-world");
		published.store.setLifeConfig("test-world", revision, {
			...config,
			images: { mode: "manual", maxPerStep: 2 },
		});
		published.store.setImageSettings("test-world", 0, {
			version: 1,
			worldVersion: null,
			route: { provider: "synthetic", model: "image" },
			eventRules: [],
			avatarEventRules: [],
			perAuthorCooldownSteps: 0,
			attachMode: "manual",
			maxJobsPerVisit: 1,
			storage: {
				maxActiveJobs: 3,
				maxArchivedJobs: 10,
				maxAssets: 10,
				maxTotalBytes: 10_000_000,
			},
		});
		const material = published.store.publishedImageMaterial(
			"test-world",
			published.postId,
			"lina",
			"friends",
		);
		if (!material) throw Error("Missing permitted post");
		const intent = published.store.freezeImageIntent({
			worldId: "test-world",
			agentId: "lina",
			source: material.source,
			visuals: [
				{
					agentId: "lina",
					profileRevision: 1,
					visualRevision: 1,
					avatarPolicyRevision: 0,
					anchors: ["blue hair"],
					textIdentity: "Approved portrait",
					reference: null,
					grants: [
						{
							grantId: "image-grant",
							revision: 1,
							purpose: {
								kind: "life",
								worldId: "test-world",
								recipientId: "friends",
							},
						},
					],
				},
			],
			requestKey: "withdrawal-check",
		});
		expect(
			published.store.imageIntentAllowed(
				"test-world",
				intent.intentId,
				"provider",
			),
		).toBe(true);
		published.store.withdrawPublicationPost("test-world", published.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(
			published.store.imageIntentAllowed(
				"test-world",
				intent.intentId,
				"provider",
			),
		).toBe(false);
	} finally {
		published.store.close();
	}
});
