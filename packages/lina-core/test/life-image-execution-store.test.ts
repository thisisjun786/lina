import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FrozenVisualIdentity } from "../src/agents/visual.ts";
import { avatarPeriodicSource } from "../src/world/image-policy.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	imageAvatarPolicy,
	imageStoreFixture,
} from "./life-image-store-fixture.ts";

function prepared() {
	const f = imageStoreFixture();
	const {
		worldId: _world,
		revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", revision, {
		...config,
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
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
	if (!source) throw Error("Missing avatar slot");
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
		source,
		visuals: [visual],
		requestKey: null,
	});
	return { ...f, intent };
}
const bounds = {
	outputBytes: 2 * 1024 * 1024,
	metadataBytes: 8192,
	manifestBytes: 8192,
};

test("known output import failure retains capacity and recovers the original artifact without another count", () => {
	const f = prepared();
	try {
		const attempt = f.store.prepareImageAttempt(
			"test-world",
			f.intent.intentId,
			"run",
		);
		const jobId = randomUUID();
		f.store.linkImageAttempt("test-world", attempt.attemptId, jobId);
		f.store.reserveImageAttempt("test-world", attempt.attemptId, bounds);
		f.store.dispatchImageAttempt("test-world", attempt.attemptId);
		const observation = {
			jobId,
			state: "failed" as const,
			endpoint: "http://127.0.0.1:43127",
			runtimeVersion: "3.14.0",
			resultFilename: "result.png",
			artifact: null,
			error: "Synthetic import failure",
		};
		f.store.observeImageAttempt("test-world", attempt.attemptId, observation);
		f.store.settleImageAttempt("test-world", attempt.attemptId, {
			kind: "result",
			resultFilename: "result.png",
		});
		expect(f.store.imageUsage("test-world").storage.outputBytes).toBe(
			bounds.outputBytes,
		);
		const artifact = {
			id: jobId,
			sha256: "a".repeat(64),
			mime: "image/png" as const,
			size: 67,
		};
		f.store.recordImageOutput("test-world", attempt.attemptId, artifact);
		f.store.recoverImageAttempt("test-world", attempt.attemptId, {
			...observation,
			state: "completed",
			artifact,
			error: null,
		});
		expect(f.store.imageUsage("test-world").storage.outputBytes).toBe(67);
		expect(f.store.imageUsage("test-world").count).toEqual({
			reserved: 0,
			consumed: 1,
			total: 1,
		});
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(
				reopened.imageAttempt("test-world", attempt.attemptId)?.observation
					?.artifact,
			).toEqual(artifact);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("WorldStore links one prepared attempt before count reservation and refuses a second dispatch", () => {
	const f = prepared();
	try {
		const attempt = f.store.prepareImageAttempt(
			"test-world",
			f.intent.intentId,
			"run",
		);
		expect(attempt.jobId).toBeNull();
		expect(() =>
			f.store.reserveImageAttempt("test-world", attempt.attemptId, bounds),
		).toThrow();
		const id = randomUUID();
		f.store.linkImageAttempt("test-world", attempt.attemptId, id);
		const reserved = f.store.reserveImageAttempt(
			"test-world",
			attempt.attemptId,
			bounds,
		);
		expect(reserved.reservation.binding.jobId).toBe(id);
		expect(f.store.imageUsage("test-world").count).toEqual({
			reserved: 1,
			consumed: 0,
			total: 1,
		});
		f.store.dispatchImageAttempt("test-world", attempt.attemptId);
		expect(() =>
			f.store.dispatchImageAttempt("test-world", attempt.attemptId),
		).toThrow();
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(
				reopened.imageAttempt("test-world", attempt.attemptId)?.jobId,
			).toBe(id);
			expect(reopened.imageUsage("test-world").count.reserved).toBe(1);
			expect(() =>
				reopened.settleImageAttempt("test-world", attempt.attemptId, {
					kind: "no_post",
				}),
			).toThrow();
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("known failed generation consumes a count, frees output bytes and permits an explicit new attempt", () => {
	const f = prepared();
	try {
		const attempt = f.store.prepareImageAttempt(
				"test-world",
				f.intent.intentId,
				"run",
			),
			jobId = randomUUID();
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
		expect(f.store.imageUsage("test-world").count).toEqual({
			reserved: 0,
			consumed: 1,
			total: 1,
		});
		expect(f.store.imageUsage("test-world").storage.outputBytes).toBe(0);
		const retry = f.store.retryImageAttempt(
			"test-world",
			f.intent.intentId,
			attempt.attemptId,
			"retry",
		);
		expect(retry.attemptNumber).toBe(2);
		expect(retry.previousAttemptId).toBe(attempt.attemptId);
		expect(retry.jobId).toBeNull();
	} finally {
		f.close();
	}
});

test("rehashed accounting UUID corruption fails the full world reopen against actual attempt lineage", () => {
	const f = prepared();
	try {
		const attempt = f.store.prepareImageAttempt(
			"test-world",
			f.intent.intentId,
			"run",
		);
		f.store.linkImageAttempt("test-world", attempt.attemptId, randomUUID());
		const count = f.store.reserveImageAttempt(
			"test-world",
			attempt.attemptId,
			bounds,
		);
		f.store.close();
		count.reservation.binding.jobId = randomUUID();
		const db = new DatabaseSync(f.path);
		db.prepare(
			"UPDATE life_image_counts SET record_json=?, digest=?, job_id=?, binding_digest=?",
		).run(
			canonicalLifeJson(count),
			lifeDigest(count),
			count.reservation.binding.jobId,
			lifeDigest(count.reservation.binding),
		);
		db.close();
		expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
	} finally {
		f.close();
	}
});
