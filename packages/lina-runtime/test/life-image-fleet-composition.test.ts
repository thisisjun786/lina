import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import { FleetLifeImages } from "../src/fleet/life-images.ts";
import { Ima2Client } from "../src/images/client.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";
import { RuntimeForeground } from "./life-runtime-fixture.ts";

test.each(["manual", "automatic"] as const)(
	"installation image composition retains %s origins, paused recovery never applies an avatar",
	async (origin) => {
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
		const {
			worldId: _world,
			revision: settingsRevision,
			...settings
		} = previous;
		world.setImageSettings(worldId, settingsRevision, {
			...settings,
			route: { provider: "api", model: "image-model" },
		});
		const resolved = world.resolveImageAvatarPolicy(
			worldId,
			"lina",
			f.visual.avatarPolicyRevision,
			imageAvatarPolicy,
		);
		f.advance(1000);
		const source = avatarPeriodicSource(
			resolved,
			f.clock(),
			world.lifeSnapshot(worldId).revision,
		);
		if (!source) throw Error("Missing fixture source");
		const intent = world.freezeImageIntent({
			...f.input,
			source,
			requestKey: origin === "manual" ? "fleet-manual" : null,
		});
		let clients = 0,
			posts = 0;
		const composition = new FleetLifeImages({
			...f.services,
			root: dirname(f.path),
			foreground: new RuntimeForeground(),
			clock: {
				now: f.clock,
				waitUntil: async () => {
					throw Error("No independent timer");
				},
			},
			assertInstallation() {},
			changed() {},
			createClient() {
				clients++;
				return new Ima2Client({
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
						throw Error("Unexpected request");
					},
				});
			},
		});
		try {
			expect(clients).toBe(0);
			const result = await composition.run(
				worldId,
				intent.intentId,
				"owner-run",
				new AbortController().signal,
			);
			expect(result.state).toBe("completed");
			// A manual generation is a candidate; the owner separately applies it.
			expect(f.agents.get("lina")?.avatarId).toBeNull();
			const candidate = f.agents.avatarHistory("lina")[0];
			expect(candidate).toBeDefined();
			expect(posts).toBe(1);
			expect(clients).toBe(1);
			const replay = await composition.run(
				worldId,
				intent.intentId,
				"owner-run",
				new AbortController().signal,
			);
			expect(replay.id).toBe(result.id);
			expect(posts).toBe(1);
			expect(
				composition.read(
					worldId,
					result.origin.kind === "life" ? result.origin.attemptId : "bad",
				).id,
			).toBe(result.id);
			expect(clients).toBe(1);
			const {
				revision: beforePause,
				worldId: _worldId,
				...active
			} = world.lifeConfig(worldId);
			const paused = world.setLifeConfig(worldId, beforePause, {
				...active,
				run: { mode: "paused" },
			});
			await composition.visit(worldId, new AbortController().signal);
			expect(f.agents.get("lina")?.avatarId).toBeNull();
			expect(posts).toBe(1);
			world.setLifeConfig(worldId, paused.revision, active);
			await composition.visit(worldId, new AbortController().signal);
			expect(f.agents.get("lina")?.avatarId === null).toBe(origin === "manual");
			expect(posts).toBe(1);
		} finally {
			await composition.close();
			f.close();
		}
	},
);
