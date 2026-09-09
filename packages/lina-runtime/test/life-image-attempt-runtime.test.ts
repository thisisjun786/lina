import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import { Ima2Client } from "../src/images/client.ts";
import { LifeImages } from "../src/images/life.ts";
import { lifeAvatarReservationId } from "../src/images/life-authority.ts";
import { catalog } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";

test("retry rejects an unknown attempt, then reuses one new UUID for a known failed attempt", async () => {
	const f = lifeImagePermissionsFixture();
	const world = f.services.world;
	const config = world.lifeConfig("test-world");
	const { worldId: _world, revision, ...configInput } = config;
	world.setLifeConfig("test-world", revision, {
		...configInput,
		usage: {
			windowMs: 1000,
			maxImages: 3,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const settings = world.imageSettings("test-world");
	if (!settings) throw Error("Missing image settings");
	const {
		worldId: _settingsWorld,
		revision: settingsRevision,
		...settingsInput
	} = settings;
	world.setImageSettings("test-world", settingsRevision, {
		...settingsInput,
		route: { provider: "api", model: "image-model" },
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
	if (!source) throw Error("Missing avatar source");
	const intent = world.freezeImageIntent({
		...f.input,
		source,
		requestKey: "retry-runtime",
	});
	let posts = 0,
		lastRequestId = "";
	const images = new LifeImages({
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
					if (path === "/api/inflight")
						return Response.json({
							jobs: [],
							terminalJobs: [
								{
									requestId: lastRequestId,
									kind: "classic",
									phase: "done",
									status: "failed",
									meta: {},
								},
							],
						});
					if (path === "/api/generate") {
						posts++;
						lastRequestId = JSON.parse(String(init.body)).requestId;
						return Response.json(
							{ requestId: lastRequestId, async: true },
							{ status: 202 },
						);
					}
					if (path.startsWith("/api/inflight/"))
						return Response.json({
							requestId: lastRequestId,
							active: false,
							aborted: true,
						});
					throw Error(`Unexpected request ${path}`);
				},
			}),
	});
	try {
		await expect(
			images.retry(
				"test-world",
				intent.intentId,
				"unknown",
				"retry",
				new AbortController().signal,
			),
		).rejects.toThrow(/prior|Unknown/);
		const initial = await images.run(
			"test-world",
			intent.intentId,
			"initial",
			"manual",
			new AbortController().signal,
		);
		const prior = world.imageAttempt(
			"test-world",
			initial.origin.kind === "life" ? initial.origin.attemptId : "invalid",
		);
		if (!prior?.jobId) throw Error("Missing initial attempt");
		await images.resume(
			"test-world",
			prior.attemptId,
			"manual",
			new AbortController().signal,
		);
		expect(images.read("test-world", prior.attemptId).state).toBe("failed");
		expect(
			f.agents.avatarCapacityReservation(
				lifeAvatarReservationId("test-world", prior.attemptId),
			)?.state,
		).toBe("released");
		const retry = await images.retry(
			"test-world",
			intent.intentId,
			prior.attemptId,
			"retry",
			new AbortController().signal,
		);
		expect(retry.id).not.toBe(initial.id);
		expect(posts).toBe(2);
		const retryAttempt = world.imageAttempt(
			"test-world",
			retry.origin.kind === "life" ? retry.origin.attemptId : "invalid",
		);
		if (!retryAttempt) throw Error("Missing retry attempt");
		await images.cancel("test-world", retryAttempt.attemptId);
		expect(
			f.agents.avatarCapacityReservation(
				lifeAvatarReservationId("test-world", retryAttempt.attemptId),
			)?.state,
		).toBe("released");
		const replay = await images.retry(
			"test-world",
			intent.intentId,
			prior.attemptId,
			"retry",
			new AbortController().signal,
		);
		expect(replay.id).toBe(retry.id);
		const changed = world.imageSettings("test-world");
		if (!changed) throw Error("Missing changed image settings");
		const {
			worldId: _changedWorld,
			revision: changedRevision,
			...changedInput
		} = changed;
		world.setImageSettings("test-world", changedRevision, {
			...changedInput,
			route: { provider: "changed", model: "changed-model" },
		});
		const originalReplay = await images.run(
			"test-world",
			intent.intentId,
			"initial",
			"manual",
			new AbortController().signal,
		);
		expect(originalReplay.id).toBe(initial.id);
		expect(originalReplay.state).toBe("failed");
		expect(posts).toBe(2);
		const attemptsBeforeClose = world.imageAttempts("test-world").length;
		await images.close();
		await expect(
			images.retry(
				"test-world",
				intent.intentId,
				prior.attemptId,
				"after-close",
				new AbortController().signal,
			),
		).rejects.toThrow(/closed/);
		expect(world.imageAttempts("test-world")).toHaveLength(attemptsBeforeClose);
	} finally {
		await images.close();
		f.close();
	}
});
