import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { publishedImageFixture } from "../../lina-core/test/life-image-publication-fixture.ts";
import { LifeImageAssets } from "../src/images/life-assets.ts";
import { lifeImageJobInput } from "../src/images/life-authority.ts";
import { LifeImagePosts } from "../src/images/life-posts.ts";
import { ImageJobStore } from "../src/images/store.ts";
import { png } from "./ima2-client-fixture.ts";

function fixture(attachMode: "manual" | "automatic" = "automatic") {
	const f = publishedImageFixture(),
		temp = mkdtempSync(join(tmpdir(), "lina-life-posts-")),
		root = join(temp, "post-images");
	const agents = new AgentStore(join(temp, "post-agents.sqlite"));
	agents.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "Private biography",
		appearance: "silver eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	const visual = agents.updateVisual("lina", 1, {
		anchors: ["blue hair"],
		textIdentity: "Approved identity",
		canonicalReferenceId: null,
		avatarPolicy: null,
		referenceLimits: { maxAssets: 3, maxTotalBytes: 100000 },
		maxHistoryRecords: 100,
	});
	const grant = agents.putVisualGrant("lina", visual.revision, {
		version: 1,
		id: "post-grant",
		agentId: "lina",
		revision: 1,
		subject: {
			kind: "text_identity",
			identityDigest: visualIdentityDigest(visual),
		},
		providerUse: true,
		purposes: [{ kind: "life", worldId: "test-world", recipientId: "friends" }],
		revoked: false,
	});
	const config = f.store.lifeConfig("test-world");
	const {
		worldId: _worldId,
		revision: configRevision,
		...configInput
	} = config;
	f.store.setLifeConfig("test-world", configRevision, {
		...configInput,
		images: { mode: "automatic", maxPerStep: 2 },
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
		attachMode,
		maxJobsPerVisit: 1,
		storage: {
			maxActiveJobs: 4,
			maxArchivedJobs: 4,
			maxAssets: 4,
			maxTotalBytes: 1000000,
		},
	});
	const publication = f.store.publishedImageMaterial(
		"test-world",
		f.postId,
		"lina",
		"friends",
	);
	if (!publication) throw Error("Missing permitted publication");
	const intent = f.store.freezeImageIntent({
		worldId: "test-world",
		agentId: "lina",
		source: publication.source,
		visuals: [
			agents.freezeVisualIdentity("lina", {
				kind: "life",
				worldId: "test-world",
				recipientId: "friends",
			}),
		],
		requestKey: "post-image",
	});
	const attempt = f.store.prepareImageAttempt(
		"test-world",
		intent.intentId,
		"post-attempt",
	);
	const limits = {
		maxActiveJobs: 4,
		maxArchivedJobs: 4,
		maxActiveBytes: 1000000,
		maxArchiveBytes: 1000000,
		maxTotalBytes: 1000000,
	};
	const jobs = new ImageJobStore(root, intent.owner, limits),
		prepared = jobs.create(lifeImageJobInput(intent, attempt));
	f.store.linkImageAttempt("test-world", attempt.attemptId, prepared.id);
	f.store.reserveImageAttempt("test-world", attempt.attemptId, {
		outputBytes: 100000,
		metadataBytes: 100000,
		manifestBytes: 100000,
	});
	f.store.dispatchImageAttempt("test-world", attempt.attemptId);
	const artifact = new LifeImageAssets(root, intent.owner, {
		beforeWrite: () => {},
		retained: () => {},
	}).importOutput(prepared.id, { bytes: png, mime: "image/png" });
	const job = jobs.update(prepared.id, {
		state: "completed",
		endpoint: "https://synthetic.invalid",
		runtimeVersion: "3.14.0",
		resultFilename: "result.png",
		artifact,
	});
	const output = {
		id: artifact.id,
		sha256: artifact.sha256,
		mime: "image/png" as const,
		size: artifact.size,
	};
	f.store.observeImageAttempt("test-world", attempt.attemptId, {
		jobId: job.id,
		state: job.state,
		endpoint: job.endpoint,
		runtimeVersion: job.runtimeVersion,
		resultFilename: job.resultFilename,
		artifact: output,
		error: job.error,
	});
	f.store.settleImageAttempt("test-world", attempt.attemptId, {
		kind: "result",
		resultFilename: "result.png",
	});
	f.store.recordImageOutput("test-world", attempt.attemptId, output);
	let current = true;
	const posts = new LifeImagePosts({
		world: f.store,
		agents,
		root,
		assertWorkCurrent: () => {
			if (!current) throw Error("Work is stale");
		},
		read: () => jobs.get(job.id),
	});
	return {
		...f,
		agents,
		grant,
		root,
		attempt,
		job,
		artifact,
		posts,
		revokeWork: () => {
			current = false;
		},
		close: () => {
			agents.close();
			f.store.close();
			rmSync(temp, { recursive: true, force: true });
		},
	};
}

test("completed event output attaches once and serves only its exact current recipient", () => {
	const f = fixture();
	try {
		const applied = f.posts.attach(f.job, "automatic");
		expect(applied.status).toBe("applied");
		expect(f.posts.attach(f.job, "automatic")).toEqual(applied);
		const asset = f.posts.asset("test-world", f.postId, "friends");
		expect(asset).toMatchObject({ mime: "image/png", etag: f.artifact.sha256 });
		expect(asset?.bytes).toEqual(new Uint8Array(png));
		expect(f.posts.asset("test-world", f.postId, "outsider")).toBeNull();
	} finally {
		f.close();
	}
});

test("automatic attachment holds without explicit automatic policy", () => {
	const f = fixture("manual");
	try {
		expect(f.posts.attach(f.job, "automatic")).toEqual({ status: "held" });
	} finally {
		f.close();
	}
});

test("revoked visual permission, withdrawn post, missing bytes, and stale work deny post asset reads", () => {
	for (const denial of ["visual", "post", "bytes", "work"] as const) {
		const f = fixture();
		try {
			expect(f.posts.attach(f.job, "automatic").status).toBe("applied");
			if (denial === "visual")
				f.agents.putVisualGrant("lina", f.agents.visual("lina").revision, {
					...f.grant,
					revision: 2,
					revoked: true,
				});
			if (denial === "post")
				f.store.withdrawPublicationPost("test-world", f.postId, {
					requestKey: `withdraw-${randomUUID()}`,
					expectedRevision: 1,
				});
			if (denial === "bytes")
				rmSync(
					join(
						f.root,
						"life",
						"images",
						"test-world",
						"lina",
						"assets",
						f.artifact.id,
					),
				);
			if (denial === "work") f.revokeWork();
			expect(f.posts.asset("test-world", f.postId, "friends")).toBeNull();
		} finally {
			f.close();
		}
	}
});
