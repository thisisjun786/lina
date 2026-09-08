import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { avatarPeriodicSource } from "../../lina-core/src/world/image-policy.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { imageAvatarPolicy } from "../../lina-core/test/life-image-store-fixture.ts";
import { Ima2Client } from "../src/images/client.ts";
import { LifeImages } from "../src/images/life.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { lifeImagePermissionsFixture } from "./life-image-permissions-fixture.ts";

test("LIFE runtime uses the shared client/jobs, retains output and reopens the same generation without POST", async () => {
	const f = lifeImagePermissionsFixture();
	const root = dirname(f.path);
	let world = f.services.world,
		posts = 0,
		clients = 0;
	const {
		worldId: _world,
		revision,
		...config
	} = world.lifeConfig("test-world");
	world.setLifeConfig("test-world", revision, {
		...config,
		usage: {
			windowMs: 1000,
			maxImages: 2,
			maxInputTokens: 100,
			maxOutputTokens: 100,
		},
	});
	const previous = world.imageSettings("test-world");
	if (!previous) throw Error("Missing settings");
	const { worldId: _id, revision: r, ...settings } = previous;
	world.setImageSettings("test-world", r, {
		...settings,
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
	if (!source) throw Error("Missing source");
	const intent = world.freezeImageIntent({
		...f.input,
		source,
		requestKey: "runtime",
	});
	const make = () =>
		new LifeImages({
			root,
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
			createClient: () => {
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
							const input = JSON.parse(String(init.body));
							return Response.json({
								...input,
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
				});
			},
		});
	let runtime = make();
	try {
		const first = await runtime.run(
			"test-world",
			intent.intentId,
			"run",
			"manual",
			new AbortController().signal,
		);
		expect(first.state).toBe("completed");
		expect(first.artifact?.size).toBe(png.length);
		expect(first.delivery.kind).toBe("life");
		expect(posts).toBe(1);
		const closing = runtime.close();
		await expect(
			runtime.run(
				"test-world",
				intent.intentId,
				"during-close",
				"manual",
				new AbortController().signal,
			),
		).rejects.toThrow(/clos/);
		await closing;
		world.close();
		world = new WorldStore(f.path, f.clock);
		runtime = make();
		expect(
			runtime.read(
				"test-world",
				first.origin.kind === "life" ? first.origin.attemptId : "invalid",
			).id,
		).toBe(first.id);
		expect(clients).toBe(1);
		const replay = await runtime.run(
			"test-world",
			intent.intentId,
			"run",
			"manual",
			new AbortController().signal,
		);
		expect(replay.id).toBe(first.id);
		expect(posts).toBe(1);
		expect(world.imageUsage("test-world").count.consumed).toBe(1);
	} finally {
		await runtime.close();
		world.close();
		f.close();
	}
});
