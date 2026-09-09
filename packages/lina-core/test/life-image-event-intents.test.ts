import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import { publishedImageFixture } from "./life-image-publication-fixture.ts";

test("actual published event freezes one permitted image intent inside the WorldStore transaction", () => {
	const f = publishedImageFixture();
	try {
		const {
			worldId: _world,
			revision,
			...config
		} = f.store.lifeConfig("test-world");
		f.store.setLifeConfig("test-world", revision, {
			...config,
			images: { mode: "manual", maxPerStep: 2 },
			usage: {
				windowMs: 1000,
				maxImages: 2,
				maxInputTokens: 100,
				maxOutputTokens: 100,
			},
		});
		f.store.setImageSettings("test-world", 0, {
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
		const publication = f.store.publishedImageMaterial(
			"test-world",
			f.postId,
			"lina",
			"friends",
		);
		if (!publication) throw Error("Missing permitted post");
		const visual: FrozenVisualIdentity = {
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
		};
		const intent = f.store.freezeImageIntent({
			worldId: "test-world",
			agentId: "lina",
			source: publication.source,
			visuals: [visual],
			requestKey: "image-request",
		});
		expect(intent.material.prompt).toContain("Residents met at the cafe.");
		expect(intent.material.prompt).not.toContain("secret dragon");
		expect(intent.material.publication).toEqual(publication);
		expect(f.store.imageIntents("test-world")).toHaveLength(1);
		const attempt = f.store.prepareImageAttempt(
			"test-world",
			intent.intentId,
			"attach-run",
		);
		const jobId = randomUUID(),
			artifact = {
				id: jobId,
				sha256: "a".repeat(64),
				mime: "image/png" as const,
				size: 67,
			};
		f.store.linkImageAttempt("test-world", attempt.attemptId, jobId);
		f.store.reserveImageAttempt("test-world", attempt.attemptId, {
			outputBytes: 100,
			metadataBytes: 16384,
			manifestBytes: 16384,
		});
		f.store.dispatchImageAttempt("test-world", attempt.attemptId);
		f.store.observeImageAttempt("test-world", attempt.attemptId, {
			jobId,
			state: "completed",
			endpoint: "http://127.0.0.1:43127",
			runtimeVersion: "3.14.0",
			resultFilename: "result.png",
			artifact,
			error: null,
		});
		f.store.settleImageAttempt("test-world", attempt.attemptId, {
			kind: "result",
			resultFilename: "result.png",
		});
		f.store.recordImageOutput("test-world", attempt.attemptId, artifact);
		const attach = {
			worldId: "test-world",
			intentId: intent.intentId,
			attemptId: attempt.attemptId,
			postId: f.postId,
			postRevision: 1,
			requestKey: "attach",
			artifact,
		};
		const receipt = f.store.attachImagePost(attach);
		expect(f.store.attachImagePost(attach)).toEqual(receipt);
		expect(
			f.store.imagePostAsset("test-world", f.postId, "friends")?.artifactId,
		).toBe(jobId);
		expect(() =>
			f.store.imagePostAsset("test-world", f.postId, "outsider"),
		).toThrow();
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "provider"),
		).toBe(true);
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "destination"),
		).toBe(true);
		f.store.withdrawPublicationPost("test-world", f.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		expect(() =>
			f.store.imagePostAsset("test-world", f.postId, "friends"),
		).toThrow();
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "provider"),
		).toBe(false);
		expect(
			f.store.imageIntentAllowed("test-world", intent.intentId, "destination"),
		).toBe(false);
		expect(f.store.imageIntent("test-world", intent.intentId)).toEqual(intent);
	} finally {
		f.store.close();
	}
});
