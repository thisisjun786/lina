import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import { Ima2Client } from "../src/images/client.ts";
import { LifeImages } from "../src/images/life.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";

test("LIFE archive records the retained immutable receipt and adopts it after reopen", async () => {
	const f = lifeImagePermissionsFixture();
	let world = f.store;
	let posts = 0;
	const settings = world.imageSettings("test-world");
	if (!settings) throw Error("Missing image settings");
	const {
		worldId: _worldId,
		revision: settingsRevision,
		...settingsInput
	} = settings;
	world.setImageSettings("test-world", settingsRevision, {
		...settingsInput,
		route: { provider: "api", model: "image-model" },
	});
	const config = world.lifeConfig("test-world");
	const {
		worldId: _configWorldId,
		revision: configRevision,
		...configInput
	} = config;
	world.setLifeConfig("test-world", configRevision, {
		...configInput,
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const policy = world.resolveImageAvatarPolicy(
		"test-world",
		"lina",
		f.visual.avatarPolicyRevision,
		imageAvatarPolicy,
	);
	const source = avatarPeriodicSource(
		policy,
		f.clock(),
		world.lifeSnapshot("test-world").revision,
	);
	if (!source) throw Error("Missing source");
	const intent = world.freezeImageIntent({
		...f.input,
		source,
		requestKey: "archive",
	});
	const make = () =>
		new LifeImages({
			root: dirname(f.path),
			world,
			agents: f.agents,
			assertWorkCurrent: () => {},
			assertInstallation: () => {},
			foreground: () => false,
			resolveReference: () => {
				throw Error("No image reference expected");
			},
			syncAvatarInventory: () => f.agents.syncAvatarInventory([]),
			onComplete: () => {},
			createClient: () =>
				new Ima2Client({
					baseUrl: "http://127.0.0.1:43127",
					fetch: async (url, init) => {
						const path = new URL(url).pathname;
						if (path === "/api/health")
							return Response.json({ ok: true, version: "3.14.0" });
						if (path === "/api/models") return Response.json(catalog);
						if (path === "/api/generate") {
							posts++;
							return Response.json({
								...JSON.parse(String(init.body)),
								filename: "result.png",
								idempotentReplay: true,
							});
						}
						if (path.endsWith("result.png"))
							return new Response(png, {
								headers: { "Content-Type": "image/png" },
							});
						throw Error(`Unexpected path ${path}`);
					},
				}),
		});
	let images = make();
	try {
		const started = await images.run(
			"test-world",
			intent.intentId,
			"archive",
			"manual",
			new AbortController().signal,
		);
		if (started.origin.kind !== "life") throw Error("Missing LIFE origin");
		const attemptId = started.origin.attemptId;
		const job = await images.reconcile("test-world", attemptId);
		if (job.origin.kind !== "life") throw Error("Missing LIFE origin");
		expect(job.delivery.kind).toBe("life");
		const current = world.imageSettings("test-world");
		if (!current) throw Error("Missing current settings");
		const {
			worldId: _currentWorldId,
			revision: currentRevision,
			...currentInput
		} = current;
		world.setImageSettings("test-world", currentRevision, {
			...currentInput,
			storage: { ...currentInput.storage, maxArchivedJobs: 0 },
		});
		expect(() => images.archive("test-world", attemptId)).toThrow(
			/archivedJobs/,
		);
		expect(images.read("test-world", attemptId).id).toBe(job.id);
		const blocked = world.imageSettings("test-world");
		if (!blocked) throw Error("Missing blocked settings");
		const {
			worldId: _blockedWorldId,
			revision: blockedRevision,
			...blockedInput
		} = blocked;
		world.setImageSettings("test-world", blockedRevision, {
			...blockedInput,
			storage: { ...blockedInput.storage, maxArchivedJobs: 4 },
		});
		const originalArchive = world.archiveImageAttempt;
		world.archiveImageAttempt = () => {
			throw Error("simulated core receipt crash");
		};
		expect(() => images.archive("test-world", attemptId)).toThrow(/simulated/);
		world.archiveImageAttempt = originalArchive;
		expect(world.imageAttemptCount("test-world", attemptId)?.archived).toBe(
			false,
		);
		await images.close();
		world.close();
		world = new (await import("../../lina-core/src/world/store.ts")).WorldStore(
			f.path,
			f.clock,
		);
		images = make();
		const first = images.archive("test-world", attemptId);
		expect(first.receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(first.receipt.size).toBeGreaterThan(0);
		expect(world.imageAttemptCount("test-world", attemptId)?.archived).toBe(
			true,
		);
		expect(images.archive("test-world", attemptId)).toEqual(first);
		expect(images.read("test-world", attemptId).id).toBe(job.id);
		expect(posts).toBe(1);
	} finally {
		await images.close();
		world.close();
		f.close();
	}
});
