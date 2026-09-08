import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import type { ImageJob } from "../src/images/contracts.ts";
import { lifeImageJobInput } from "../src/images/life-authority.ts";
import { lifeImagePorts } from "../src/images/life-ports.ts";
import { ImageJobStore } from "../src/images/store.ts";
import { png } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";

function fixture() {
	const f = lifeImagePermissionsFixture();
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
		f.visual.avatarPolicyRevision,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		f.store.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing source");
	const intent = f.store.freezeImageIntent({
		...f.input,
		source,
		requestKey: "port",
	});
	const attempt = f.store.prepareImageAttempt(
		"test-world",
		intent.intentId,
		"run",
	);
	const store = new ImageJobStore(dirname(f.path), intent.owner, {
		maxActiveJobs: 4,
		maxArchivedJobs: 4,
		maxActiveBytes: 200000,
		maxArchiveBytes: 200000,
		maxTotalBytes: 400000,
	});
	const job = store.create(lifeImageJobInput(intent, attempt));
	f.store.linkImageAttempt("test-world", attempt.attemptId, job.id);
	f.store.reserveImageAttempt("test-world", attempt.attemptId, {
		outputBytes: 2 * 1024 * 1024,
		metadataBytes: 65536,
		manifestBytes: 65536,
	});
	const ports = lifeImagePorts({
		...f.services,
		root: dirname(f.path),
		owner: intent.owner,
		resolveReference: () => {
			throw Error("Text-only identity has no reference");
		},
		assertLease: () => {},
		onComplete: () => {},
	});
	return { ...f, store, world: f.services.world, attempt, job, ports };
}

test("LIFE artifact port records the actual output before terminal notice and adopts identical UUID bytes", async () => {
	const f = fixture();
	try {
		f.world.dispatchImageAttempt("test-world", f.attempt.attemptId);
		const job: ImageJob = {
			...f.job,
			state: "queued",
			endpoint: "http://127.0.0.1:43127",
			runtimeVersion: "3.14.0",
			resultFilename: "result.png",
		};
		const asset = await f.ports.artifacts.importOutput(job, {
			mime: "image/png",
			bytes: png,
		});
		expect(asset.id).toBe(job.id);
		expect(f.world.imageUsage("test-world").storage.outputBytes).toBe(
			png.length,
		);
		expect(f.world.imageUsage("test-world").count.consumed).toBe(1);
		const completed: ImageJob = { ...job, state: "completed", artifact: asset };
		await f.ports.artifacts.verify(completed);
		const receipt = await f.ports.completion.complete(completed);
		expect(receipt.kind).toBe("life");
		expect(await f.ports.completion.complete(completed)).toEqual(receipt);
		expect(
			await f.ports.artifacts.importOutput(completed, {
				mime: "image/png",
				bytes: png,
			}),
		).toEqual(asset);
	} finally {
		f.close();
	}
});

test("source withdrawal does not erase known generation receipts, and forged UUIDs cannot import", async () => {
	const f = fixture();
	try {
		f.world.dispatchImageAttempt("test-world", f.attempt.attemptId);
		f.revokeWork();
		const job: ImageJob = {
			...f.job,
			state: "failed",
			endpoint: "http://127.0.0.1:43127",
			runtimeVersion: "3.14.0",
			error: "Known failure",
		};
		expect((await f.ports.completion.complete(job)).kind).toBe("life");
		expect(f.world.imageUsage("test-world").count.consumed).toBe(1);
		expect(f.world.imageUsage("test-world").storage.outputBytes).toBe(0);
		expect(() => f.ports.changed({ ...job, id: randomUUID() })).toThrow();
	} finally {
		f.close();
	}
});
