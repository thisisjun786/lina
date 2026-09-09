import { expect, test } from "bun:test";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import { hash } from "../../lina-core/src/attachments/validation.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { Ima2Client } from "../src/images/client.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test.each(["authored", "legacy"] as const)(
	"%s fleet schedules portraits, serves permitted bytes and resumes the next slot after restart without a duplicate",
	async (kind) => {
		let posts = 0;
		const f = await fleetLifeFixture({
			createImageClient: () =>
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
								filename: "portrait.png",
								idempotentReplay: true,
							});
						}
						if (path.endsWith("portrait.png"))
							return new Response(png, {
								headers: { "Content-Type": "image/png" },
							});
						throw Error("Unexpected image provider request");
					},
				}),
		});
		try {
			if (kind === "authored") f.setup();
			else f.app.fleet.lifeStorage.create(worldDefinition());
			const world = f.app.fleet.lifeStorage;
			const { worldId, revision, ...config } = world.lifeConfig("test-world");
			f.app.fleet.life.setConfig(worldId, revision, {
				...config,
				usage: {
					...config.usage,
					windowMs: 10000,
					maxInputTokens: 1000,
					maxOutputTokens: 1000,
					maxImages: 2,
				},
				avatars: { mode: "automatic", intervalMs: 1000, maxPerWindow: 2 },
			});
			world.setImageSettings(worldId, 0, {
				version: 1,
				worldVersion: kind === "authored" ? 1 : null,
				route: { provider: "api", model: "image-model" },
				eventRules: [],
				avatarEventRules: [],
				perAuthorCooldownSteps: 0,
				attachMode: "automatic",
				maxJobsPerVisit: 2,
				storage: {
					maxActiveJobs: 4,
					maxArchivedJobs: 4,
					maxAssets: 4,
					maxTotalBytes: 10000000,
				},
			});
			const visual = f.app.fleet.agents.updateVisual("lina", 1, {
				anchors: ["silver hair"],
				textIdentity: "approved portrait",
				canonicalReferenceId: null,
				avatarPolicy: {
					worldId,
					applyMode: "automatic",
					whilePinned: "skip",
					schedule: { kind: "wall", epochMs: 1000 },
					eventFamilyIds: [],
				},
				referenceLimits: { maxAssets: 3, maxTotalBytes: 100000 },
				maxHistoryRecords: 100,
			});
			const grant = f.app.fleet.agents.putVisualGrant("lina", visual.revision, {
				version: 1,
				id: "portrait-grant",
				agentId: "lina",
				revision: 1,
				subject: {
					kind: "text_identity",
					identityDigest: visualIdentityDigest(visual),
				},
				providerUse: true,
				purposes: [{ kind: "avatar" }],
				revoked: false,
			});
			f.app.fleet.publicationChanged();
			await f.clock.waitingAt(1000);
			expect(posts).toBe(0);
			f.clock.advance(1000);
			await f.clock.waitingAt(2000);
			expect(posts).toBe(1);
			expect(f.app.fleet.agents.get("lina")?.avatarId).toBe(hash(png));
			expect(f.app.fleet.agents.avatarHistory("lina")).toHaveLength(1);
			const first = world.imageAttempts(worldId)[0]?.jobId;
			const firstAttempt = world.imageAttempts(worldId)[0]?.attemptId;
			if (!firstAttempt) throw Error("Missing original image attempt");
			const response = await fetch(
				`http://127.0.0.1:${f.app.port}/api/avatars/${hash(png)}`,
			);
			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(
				new Uint8Array(png),
			);
			await f.restart();
			await f.clock.waitingAt(2000);
			expect(posts).toBe(1);
			expect(
				f.app.fleet.lifeStorage.imageAttemptCount(worldId, firstAttempt)
					?.archived,
			).toBe(true);
			expect(f.app.fleet.lifeStorage.imageAttempts(worldId)[0]?.jobId).toBe(
				first,
			);
			f.clock.advance(2000);
			await f.clock.waitingAt(3000);
			expect(posts).toBe(2);
			expect(f.app.fleet.agents.avatarHistory("lina")).toHaveLength(2);
			f.app.fleet.agents.putVisualGrant(
				"lina",
				f.app.fleet.agents.visual("lina").revision,
				{ ...grant, revision: 2, revoked: true },
			);
			const denied = await fetch(
				`http://127.0.0.1:${f.app.port}/api/avatars/${hash(png)}`,
			);
			expect(denied.status).not.toBe(200);
			expect(f.providerCalls).toBe(0);
		} finally {
			await f.close();
		}
	},
);
