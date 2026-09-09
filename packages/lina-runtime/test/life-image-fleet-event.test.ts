import { expect, test } from "bun:test";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import type { WorldStore } from "../../lina-core/src/world/store.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { Ima2Client } from "../src/images/client.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("accepted event becomes one permitted post image through Fleet and fixed web proxy, survives restart and hides on revocation", async () => {
	let posts = 0;
	let imageServer: ReturnType<typeof Bun.serve> | undefined;
	const f = await fleetLifeFixture({
		createImageClient: () => {
			imageServer ??= Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async (request) => {
					const path = new URL(request.url).pathname;
					if (path === "/api/health")
						return Response.json({ ok: true, version: "3.14.0" });
					if (path === "/api/models") return Response.json(catalog);
					if (path === "/api/generate") {
						const body: unknown = await request.json();
						if (!body || typeof body !== "object" || Array.isArray(body))
							return new Response("Expected image request object", {
								status: 400,
							});
						posts++;
						return Response.json({
							...body,
							filename: "scene.png",
							idempotentReplay: true,
						});
					}
					if (path.endsWith("scene.png"))
						return new Response(png, {
							headers: { "Content-Type": "image/png" },
						});
					throw Error("Unexpected image request");
				},
			});
			return new Ima2Client({ baseUrl: imageServer.url.origin });
		},
	});
	let web: ReturnType<typeof startWebServer> | undefined;
	try {
		f.setup(false, false, (pack) =>
			pack.life.projection.disclosures.push({
				subject: { kind: "world_event", id: "test-world:1" },
				policy: {
					knowers: ["lina"],
					disclosures: [{ agentId: "lina", recipientId: "friends" }],
					publication: ["friends"],
				},
			}),
		);
		const worldId = "test-world",
			world = f.app.fleet.lifeStorage;
		const { worldId: _id, revision, ...config } = world.lifeConfig(worldId);
		world.setLifeConfig(worldId, revision, {
			...config,
			publication: { mode: "manual", recipientIds: ["friends"] },
			images: { mode: "automatic", maxPerStep: 1 },
			usage: {
				windowMs: 100000,
				maxInputTokens: 100000,
				maxOutputTokens: 100000,
				maxImages: 2,
			},
		});
		world.setPublicationSettings(worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 8,
			maxActionsPerChain: 10,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		});
		const visual = f.app.fleet.agents.updateVisual("lina", 1, {
			anchors: ["silver hair"],
			textIdentity: "approved resident",
			canonicalReferenceId: null,
			avatarPolicy: null,
			referenceLimits: { maxAssets: 1, maxTotalBytes: 10000 },
			maxHistoryRecords: 50,
		});
		const grant = f.app.fleet.agents.putVisualGrant("lina", visual.revision, {
			version: 1,
			id: "scene-grant",
			agentId: "lina",
			revision: 1,
			subject: {
				kind: "text_identity",
				identityDigest: visualIdentityDigest(visual),
			},
			providerUse: true,
			purposes: [{ kind: "life", worldId, recipientId: "friends" }],
			revoked: false,
		});
		const runtime = f.app.fleet.lifeRuntime;
		const step = await runtime.run(
			worldId,
			"image-event",
			2,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		model.text = (request) => {
			if (request.version !== 2) throw Error("Unexpected simulation call");
			return JSON.stringify({
				kind: "post",
				segments: [
					{
						kind: "claim",
						claimId: JSON.parse(request.input).material.claims[0].id,
					},
				],
			});
		};
		const publication = await runtime.publish(
			worldId,
			{
				requestKey: "publish-image-event",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			new AbortController().signal,
		);
		expect(publication.outcomes).toEqual(["published"]);
		world.setImageSettings(worldId, 0, {
			version: 1,
			worldVersion: 1,
			route: { provider: "api", model: "image-model" },
			eventRules: [
				{
					familyId: "meet",
					agentIds: ["lina"],
					trigger: "event",
					composition: "single_subject",
				},
			],
			avatarEventRules: [],
			perAuthorCooldownSteps: 0,
			attachMode: "automatic",
			maxJobsPerVisit: 1,
			storage: {
				maxActiveJobs: 4,
				maxArchivedJobs: 4,
				maxAssets: 4,
				maxTotalBytes: 10000000,
			},
		});
		await f.app.images().visit(worldId, new AbortController().signal);
		expect(posts).toBe(1);
		const { token } = world.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const headers = { Authorization: `Bearer ${token}` };
		const feedPath = `/api/life/worlds/${worldId}/feed`;
		const feed = await fetch(`http://127.0.0.1:${f.app.port}${feedPath}`, {
			headers,
		});
		expect(feed.status).toBe(200);
		const payload = (await feed.json()) as ReturnType<
			WorldStore["publicationFeed"]
		>;
		const image = payload.items[0]?.image;
		expect(image?.mime).toBe("image/png");
		if (!image) throw Error("Missing feed image");
		expect(JSON.stringify(payload)).not.toContain("prompt");
		web = startWebServer({
			port: 0,
			upstream: `ws://127.0.0.1:${f.app.port}/ws`,
			assets: { html: "ok", script: "", css: "", icon: "" },
		});
		const asset = await fetch(`http://127.0.0.1:${web.port}${image.url}`, {
			headers: { ...headers, Origin: `http://127.0.0.1:${web.port}` },
		});
		expect(asset.status).toBe(200);
		expect(new Uint8Array(await asset.arrayBuffer())).toEqual(
			new Uint8Array(png),
		);
		await web.stop(true);
		web = undefined;
		await f.restart();
		const reopened = await fetch(`http://127.0.0.1:${f.app.port}${image.url}`, {
			headers,
		});
		expect(reopened.status).toBe(200);
		expect(posts).toBe(1);
		f.app.fleet.agents.putVisualGrant(
			"lina",
			f.app.fleet.agents.visual("lina").revision,
			{ ...grant, revision: 2, revoked: true },
		);
		const denied = await fetch(`http://127.0.0.1:${f.app.port}${image.url}`, {
			headers,
		});
		expect(denied.status).toBe(404);
		const withdrawn = (await (
			await fetch(`http://127.0.0.1:${f.app.port}${feedPath}`, { headers })
		).json()) as ReturnType<WorldStore["publicationFeed"]>;
		expect(withdrawn.items[0]?.image).toBeUndefined();
		expect(withdrawn.items).toHaveLength(1);
		expect(f.providerCalls).toBe(0);
	} finally {
		await web?.stop(true);
		await f.close();
		await imageServer?.stop(true);
	}
});
