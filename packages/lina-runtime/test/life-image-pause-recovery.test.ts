import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { FleetLifeImages } from "../src/fleet/life-images.ts";
import { Ima2Client } from "../src/images/client.ts";
import { lifeAvatarReservationId } from "../src/images/life-authority.ts";
import { LifeImageDiscovery } from "../src/images/life-discovery.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";
import { RuntimeForeground } from "./life-runtime-fixture.ts";

async function fixture(blockAtCatalog = false) {
	let shouldBlock = blockAtCatalog;
	const f = lifeImagePermissionsFixture();
	const world = f.store;
	const { worldId, revision, ...config } = world.lifeConfig("test-world");
	world.setLifeConfig(worldId, revision, {
		...config,
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const previous = world.imageSettings(worldId);
	if (!previous) throw Error("Missing fixture settings");
	const { worldId: _w, revision: settingsRevision, ...settings } = previous;
	world.setImageSettings(worldId, settingsRevision, {
		...settings,
		route: { provider: "api", model: "image-model" },
	});
	let posts = 0;
	const foreground = new RuntimeForeground();
	const composition = new FleetLifeImages({
		...f.services,
		root: dirname(f.path),
		foreground,
		clock: {
			now: f.clock,
			waitUntil: async () => {
				throw Error("No timer");
			},
		},
		assertInstallation() {},
		changed() {},
		createClient() {
			return new Ima2Client({
				baseUrl: "http://127.0.0.1:43127",
				fetch: async (url, init) => {
					const path = new URL(url).pathname;
					if (path === "/api/health")
						return Response.json({ ok: true, version: "3.14.0" });
					if (path === "/api/models") {
						if (shouldBlock) {
							shouldBlock = false;
							foreground.set(true);
						}
						return Response.json(catalog);
					}
					if (path === "/api/generate") {
						posts++;
						return Response.json({
							...JSON.parse(String(init.body)),
							filename: "portrait.png",
							idempotentReplay: true,
						});
					}
					if (path.endsWith("portrait.png"))
						return new Response(png, {
							headers: { "Content-Type": "image/png" },
						});
					throw Error("Unexpected request");
				},
			});
		},
	});
	return {
		f,
		world,
		worldId,
		composition,
		foreground,
		posts: () => posts,
		async close() {
			await composition.close();
			f.close();
		},
	};
}
for (const scenario of ["automatic", "manual", "retained"] as const) {
	test(`paused image ${scenario} does not hold future avatar slots after resume`, async () => {
		const x = await fixture();
		const { f, world, worldId, composition } = x;
		try {
			const { worldId: _id, revision, ...active } = world.lifeConfig(worldId);
			const paused = world.setLifeConfig(worldId, revision, {
				...active,
				run: { mode: "paused" },
			});
			f.advance(1000);
			if (scenario === "automatic") {
				const intentsBefore = world.imageIntents(worldId);
				await composition.visit(worldId, new AbortController().signal);
				expect(world.imageIntents(worldId)).toEqual(intentsBefore);
				expect(world.imageAttempts(worldId)).toHaveLength(0);
			} else {
				const discovery = new LifeImageDiscovery(world, f.agents);
				// Freeze a manual selector using a temporarily active policy, then pause again.
				world.setLifeConfig(worldId, paused.revision, active);
				const candidate = discovery.preview(worldId, f.clock()).candidates[0];
				if (!candidate) throw Error("Missing configured avatar candidate");
				const intent = discovery.freeze(worldId, candidate);
				const current = world.lifeConfig(worldId);
				world.setLifeConfig(worldId, current.revision, {
					...active,
					run: { mode: "paused" },
				});
				if (scenario === "manual") {
					await expect(
						composition.run(
							worldId,
							intent.intentId,
							"manual-paused",
							new AbortController().signal,
						),
					).rejects.toThrow();
					expect(world.imageAttempts(worldId)).toHaveLength(0);
				} else {
					const attempt = world.prepareImageAttempt(
						worldId,
						intent.intentId,
						"old-prepared",
					);
					expect(
						world.imageAttemptCount(worldId, attempt.attemptId),
					).toBeNull();
				}
			}
			expect(x.posts()).toBe(0);
			const current = world.lifeConfig(worldId);
			world.setLifeConfig(worldId, current.revision, active);
			f.advance(1000);
			await composition.visit(worldId, new AbortController().signal);
			expect(x.posts()).toBe(1);
			expect(f.agents.get("lina")?.avatarId).not.toBeNull();
			f.advance(1000);
			await composition.visit(worldId, new AbortController().signal);
			expect(x.posts()).toBe(2);
		} finally {
			await x.close();
		}
	});
}

test.each([false, true])(
	"prepared portrait recovery preserves dispatch uncertainty: %s",
	async (dispatched) => {
		const x = await fixture(true);
		const { f, world, worldId, composition } = x;
		try {
			f.advance(1000);
			const discovery = new LifeImageDiscovery(world, f.agents);
			const candidate = discovery.preview(worldId, f.clock()).candidates[0];
			if (!candidate) throw Error("Missing candidate");
			const selected = discovery.freeze(worldId, candidate);
			const intent = world.freezeImageIntent({
				...f.input,
				source: selected.source,
				requestKey: "manual-reserved",
			});
			const job = await composition.run(
				worldId,
				intent.intentId,
				"reserved-run",
				new AbortController().signal,
			);
			expect(job.state).toBe("prepared");
			expect(x.posts()).toBe(0);
			if (job.origin.kind !== "life") throw Error("Missing LIFE origin");
			const attemptId = job.origin.attemptId,
				reservationId = lifeAvatarReservationId(worldId, attemptId);
			expect(
				world.imageAttemptCount(worldId, attemptId)?.dispatchAtMs,
			).toBeNull();
			expect(f.agents.avatarCapacityReservation(reservationId)?.state).toBe(
				"reserved",
			);
			if (dispatched) world.dispatchImageAttempt(worldId, attemptId);
			x.foreground.set(false);
			const { worldId: _id, revision, ...active } = world.lifeConfig(worldId);
			const paused = world.setLifeConfig(worldId, revision, {
				...active,
				run: { mode: "paused" },
			});
			await composition.visit(worldId, new AbortController().signal);
			if (dispatched) {
				expect(world.imageAttemptCount(worldId, attemptId)?.state).toBe(
					"unknown",
				);
				expect(f.agents.avatarCapacityReservation(reservationId)?.state).toBe(
					"reserved",
				);
				expect(world.imageAttempt(worldId, attemptId)?.observation?.state).toBe(
					"prepared",
				);
				expect(x.posts()).toBe(0);
				return;
			}
			expect(world.imageAttempt(worldId, attemptId)?.observation?.state).toBe(
				"cancelled",
			);
			expect(world.imageAttemptCount(worldId, attemptId)?.terminal).toBe(
				"no_post",
			);
			expect(f.agents.avatarCapacityReservation(reservationId)?.state).toBe(
				"released",
			);
			expect(x.posts()).toBe(0);
			const attemptsBefore = world.imageAttempts(worldId);
			await expect(
				composition.retry(
					worldId,
					intent.intentId,
					attemptId,
					"retry-paused",
					new AbortController().signal,
				),
			).rejects.toThrow();
			expect(world.imageAttempts(worldId)).toEqual(attemptsBefore);
			world.setLifeConfig(worldId, paused.revision, active);
			f.advance(1000);
			await composition.visit(worldId, new AbortController().signal);
			expect(x.posts()).toBe(1);
		} finally {
			await x.close();
		}
	},
);
