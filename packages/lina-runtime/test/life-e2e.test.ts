import { expect, test } from "bun:test";
import { createWorkManagementAuthority } from "../../lina-codex/src/task-work-authority.ts";
import { visualIdentityDigest } from "../../lina-core/src/agents/visual-validation.ts";
import type { WorldStore } from "../../lina-core/src/world/store.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { Ima2Client } from "../src/images/client.ts";
import type { AppOptions } from "../src/session-app.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { createOrdinaryWorldContext } from "../src/world.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { catalog, png } from "./ima2-client-fixture.ts";
import { lifeAcceptanceFixture } from "./life-acceptance-fixture.ts";

test("one installation carries permitted work into relations, a pictured post and scoped feedback across restart", async () => {
	let posts = 0;
	const imageInputs: unknown[] = [];
	let ordinarySource: AppOptions["world"];
	const engine = testSessionEngine();
	let imageServer: ReturnType<typeof Bun.serve> | undefined;
	const { f, rpc } = await lifeAcceptanceFixture({
		createApp(input) {
			ordinarySource = input.world;
			return startPersistentApp({ ...input, engine });
		},
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
						imageInputs.push(body);
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
		f.setup(false, false, (pack) => {
			for (const event of pack.autonomy.events) event.cooldownSteps = 0;
			const secret = pack.variables.find((v) => v.id === "secret");
			if (!secret) throw Error("Missing planted private variable");
			secret.initial = "PRIVATE_ACCEPTANCE_SECRET";
		});
		const authoredProfile = f.app.fleet.agents.get("lina");

		const worldId = "test-world",
			world = f.app.fleet.lifeStorage;
		const { worldId: _id, revision, ...config } = world.lifeConfig(worldId);
		world.setLifeConfig(worldId, revision, {
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "research",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 3,
						requiredMatch: true,
					},
				],
			},
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
			version: 2,
			worldVersion: 1,
			eventRules: [
				{
					familyId: "meet",
					authorAgentIds: ["lina"],
					recipientIds: ["friends"],
					summary: "Residents met after permitted research.",
				},
			],
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
		world.setWorldBinding("lina", 0, {
			version: 2,
			worldId,
			projectionPolicyRevision: 1,
			conversationRecipientId: null,
		});
		const beforeWork = await runtime.run(
			worldId,
			"before-work",
			2,
			new AbortController().signal,
		);
		expect(beforeWork.decision.kind).toBe("quiet");
		expect(f.models[0]?.requests).toHaveLength(0);
		const task = await f.app.tasks.create({
			ownerAgentId: "lina",
			title: "Research",
			cwd: f.root,
			prompt: "PRIVATE_ACCEPTANCE_WORK",
			requestId: "acceptance-task",
		});
		if (!task.threadId) throw Error("Missing task thread");
		const ended = Promise.withResolvers<void>(),
			off = f.app.tasks.subscribeWork(() => ended.resolve());
		rpc.completeTurn(task.threadId);
		await ended.promise;
		off();
		const receipt = f.app.tasks.workReceipts(task.id)[0];
		if (!receipt) throw Error("Missing actual task receipt");
		const share = {
			receiptId: receipt.id,
			expectedPolicyRevision: 0,
			requestId: "acceptance-share",
			selection: {
				worldIds: [worldId],
				categoryId: "research",
				shareOutcome: true,
				shareParticipants: false,
				summary: null,
			},
		};
		await f.app.tasks.shareWork(
			task.id,
			share,
			createWorkManagementAuthority("management", "lina"),
		);
		await f.app.tasks.shareWork(
			task.id,
			share,
			createWorkManagementAuthority("management", "lina"),
		);
		expect(world.workEvidence(worldId).records).toHaveLength(1);

		const step = await runtime.run(
			worldId,
			"image-event",
			2,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		expect(step.decision.kind).toBe("event");
		expect(
			step.decision.candidates.some((c) =>
				c.contributions.some((x) => x.kind === "work" && x.value === 3),
			),
		).toBe(true);
		expect(
			step.outcome?.commit.experiences.some((x) => x.id.startsWith("work-")),
		).toBe(true);
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const simulationText = model.text;
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
		const { token, grant: viewer } = world.mintPublicationViewer(worldId, {
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

		const post = payload.items[0];
		if (!post) throw Error("Missing permitted post");
		const principal = { kind: "viewer" as const, grantId: viewer.id };
		const replyInput = {
			requestKey: "acceptance-feedback",
			expectedPostRevision: post.revision,
			text: "FEEDBACK_FOR_LINA_ONLY",
		};
		const reply = world.replyToPublication(
			worldId,
			principal,
			post.id,
			replyInput,
		);
		expect(
			world.replyToPublication(worldId, principal, post.id, replyInput).postId,
		).toBe(reply.postId);
		model.text = simulationText;
		const modelBoundary = model.requests.length;
		const next = await runtime.run(
			worldId,
			"after-feedback",
			2,
			new AbortController().signal,
		);
		expect(next.status).toBe("accepted");
		expect(next.outcome?.commit.consumedInputIds).toEqual(
			reply.interaction?.observationIds,
		);
		expect(
			next.outcome?.commit.experiences.some(
				(x) => x.id.startsWith("feedback-") && x.agentId === "lina",
			),
		).toBe(true);
		const feedbackCalls = model.requests.slice(modelBoundary);
		expect(feedbackCalls.find((x) => x.lane === "director")?.input).toContain(
			"FEEDBACK_FOR_LINA_ONLY",
		);
		for (const call of feedbackCalls.filter((x) => x.agentId !== "lina"))
			expect(call.input).not.toContain("FEEDBACK_FOR_LINA_ONLY");
		for (const sentinel of [
			"PRIVATE_ACCEPTANCE_WORK",
			"PRIVATE_ACCEPTANCE_SECRET",
		]) {
			expect(JSON.stringify(model.requests)).not.toContain(sentinel);
			expect(JSON.stringify(imageInputs)).not.toContain(sentinel);
			expect(JSON.stringify(payload)).not.toContain(sentinel);
		}
		const state = world.lifeSnapshot(worldId);
		expect(
			state.attitudes.find(
				(x) => x.fromAgentId === "lina" && x.toAgentId === "mira",
			)?.value,
		).toBe(2);
		expect(
			state.attitudes.find(
				(x) => x.fromAgentId === "mira" && x.toAgentId === "lina",
			)?.value ?? 0,
		).toBe(0);
		await f.app.fleet.app("lina");
		const ordinary = createOrdinaryWorldContext("lina", () =>
			typeof ordinarySource === "function" ? ordinarySource() : undefined,
		);
		expect(
			ordinary
				.growth()
				?.attitudes.some((x) => x.toAgentId === "mira" && x.value === 2),
		).toBe(true);
		expect(JSON.stringify(ordinary.growth())).not.toContain(
			"PRIVATE_ACCEPTANCE_SECRET",
		);
		expect(f.app.fleet.agents.get("lina")).toEqual(authoredProfile);
		await web.stop(true);
		web = undefined;
		await f.restart();
		expect(f.app.fleet.lifeStorage.lifeSnapshot(worldId)).toEqual(state);
		const replay = await f.app.fleet.lifeRuntime.run(
			worldId,
			"after-feedback",
			2,
			new AbortController().signal,
		);
		expect(replay.id).toBe(next.id);
		expect(f.models.at(-1)?.requests).toHaveLength(0);
		expect(f.app.fleet.lifeStorage.workEvidence(worldId).records).toHaveLength(
			1,
		);
		expect(
			f.app.fleet.lifeStorage.replyToPublication(
				worldId,
				principal,
				post.id,
				replyInput,
			).postId,
		).toBe(reply.postId);

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
		expect(withdrawn.items).toHaveLength(2);
		expect(f.providerCalls).toBe(0);
	} finally {
		await web?.stop(true);
		await f.close();
		await imageServer?.stop(true);
	}
	// Three causal boundaries plus all owner audits are integration work, not a latency benchmark.
}, 30_000);
