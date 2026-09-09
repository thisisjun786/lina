import { expect, test } from "bun:test";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../lina-core/src/world/publication-model.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { lifePublicationRoutes } from "../src/fleet/life-publication-routes.ts";
import { createWorkBridge } from "../src/life/work-bridge.ts";
import { assertWorkSourceCurrent } from "../src/life/work-source.ts";
import { workBridgeFixture } from "./helpers/work-bridge.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

test("live TaskManager revocation fences derived feed and interactions before a delayed world restriction is delivered", async () => {
	const f = await workBridgeFixture();
	const r = runtimeStoreFixture(false, (pack) =>
		pack.life.projection.disclosures.push({
			subject: { kind: "world_event", id: "test-world:1" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "friends" }],
				publication: ["friends"],
			},
		}),
	);
	const store = r.store,
		worldId = f.worldId,
		bridge = createWorkBridge({ source: f.tasks, world: store, onError() {} });
	let server: ReturnType<typeof Bun.serve> | undefined;
	try {
		const { worldId: _world, revision, ...config } = store.lifeConfig(worldId);
		store.setLifeConfig(worldId, revision, {
			...config,
			version: 2,
			work: f.work,
			publication: { mode: "manual", recipientIds: ["friends"] },
		});
		store.setPublicationSettings(worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: ["like"],
			maxChainDepth: 10,
			maxActionsPerChain: 20,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		});
		bridge.start();
		await f.share();
		const frozen = store.workEvidence(worldId);
		expect(frozen.records).toHaveLength(1);
		const accepted = await r.runner.run(
			worldId,
			"work-event",
			revision + 1,
			new AbortController().signal,
		);
		expect(accepted.status).toBe("accepted");
		expect(
			accepted.outcome?.commit.experiences.some((experience) =>
				experience.id.startsWith("work-"),
			),
		).toBe(true);
		const run = store.beginPublicationRun(
				worldId,
				{
					requestKey: "publication",
					expectedConfigRevision: revision + 1,
					expectedSettingsRevision: 1,
					mode: "manual",
				},
				"publication",
				100,
			),
			lease = run.lease,
			item = run.batch[0];
		if (
			!lease ||
			!item ||
			!config.models?.actor ||
			"tier" in config.models.actor
		)
			throw Error("Missing work-derived publication candidate");
		const job = store.freezePublicationJob(
			lease,
			run.id,
			item.jobId,
			publicationAuthor,
			1,
		);
		const request = {
			version: 2 as const,
			id: publicationModelId(job.attemptId),
			worldId,
			jobId: job.id,
			lane: "publication" as const,
			agentId: job.authorAgentId,
			...config.models.actor,
			modelSettingsRevision: 1,
			...buildPublicationModelInput(job),
			limits: {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 100000,
				maxOutputBytes: 10000,
				timeoutMs: 1000,
			},
		};
		const prepared = {
			version: 1 as const,
			request,
			inputDigest: lifeDigest(request),
			capabilityFingerprint: "a".repeat(64),
			nativeReference: "synthetic-publication",
		};
		store.preparePublicationModel(lease, run.id, prepared);
		store.dispatchPublicationModel(lease, run.id, job.id, request.id);
		store.finishPublicationModel(worldId, job.id, request.id, {
			status: "completed",
			result: {
				version: 1,
				requestId: request.id,
				inputDigest: prepared.inputDigest,
				capabilityFingerprint: prepared.capabilityFingerprint,
				nativeReference: prepared.nativeReference,
				provider: request.provider,
				model: request.model,
				threadId: "thread",
				turnId: "turn",
				text: JSON.stringify({
					kind: "post",
					segments: [
						{ kind: "imaginative", text: "A public work reflection." },
					],
				}),
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		});
		const published = store.completePublicationJob(lease, run.id, job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		if (!published.postId) throw Error("Missing public post");
		store.advancePublicationRun(lease, run.id, job.id);
		const { token } = store.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		if (!token) throw Error("Missing token");
		let sourceChecks = 0;
		const services = {
			store: () => store,
			run: async () => {
				throw Error("Feed must not start models");
			},
			assertSourceCurrent: (id: string) => {
				sourceChecks++;
				assertWorkSourceCurrent(f.tasks, store.workEvidence(id));
			},
		};
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				return (
					(await lifePublicationRoutes(request, services, async () => {
						const value: unknown = await request.json();
						if (!value || typeof value !== "object" || Array.isArray(value))
							throw Error("Invalid JSON object");
						return { ...value };
					})) ?? new Response(null, { status: 404 })
				);
			},
		});
		const url = `http://127.0.0.1:${server.port}/api/life/worlds/${worldId}/feed`,
			headers = { authorization: `Bearer ${token}` };
		expect((await fetch(url, { headers })).status).toBe(200);
		bridge.close();
		await f.share(null);
		expect(store.workEvidence(worldId)).toEqual(frozen);
		const before = store.lifeInputs(worldId);
		expect((await fetch(url, { headers })).status).toBe(403);
		expect(
			(await fetch(`${url}/posts/${published.postId}`, { headers })).status,
		).toBe(403);
		expect(
			(
				await fetch(`${url}/posts/${published.postId}/reactions`, {
					method: "PUT",
					headers: { ...headers, "content-type": "application/json" },
					body: JSON.stringify({
						requestKey: "late-reaction",
						expectedPostRevision: 1,
						reactionId: "like",
						active: true,
					}),
				})
			).status,
		).toBe(403);
		expect(store.lifeInputs(worldId)).toEqual(before);
		expect(sourceChecks).toBeGreaterThanOrEqual(4);
	} finally {
		if (server) await server.stop(true);
		bridge.close();
		await r.close();
		await f.close();
	}
});
