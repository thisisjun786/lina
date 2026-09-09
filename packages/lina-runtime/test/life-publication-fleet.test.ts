import { expect, test } from "bun:test";
import type { PublicationRun } from "../../lina-core/src/world/publication-types.ts";
import { lifeDefinition } from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test("Fleet feed invokes its current source hook without warming runtime or model ownership", async () => {
	const f = await fleetLifeFixture();
	try {
		const store = f.app.fleet.lifeStorage,
			worldId = "test-world";
		store.create(worldDefinition());
		store.prepareLife(lifeDefinition());
		const { worldId: _w, revision, ...config } = store.lifeConfig(worldId);
		store.setLifeConfig(worldId, revision, {
			...config,
			publication: { mode: "manual", recipientIds: ["friends"] },
		});
		store.setPublicationSettings(worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 0,
			maxActionsPerChain: 0,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 0,
		});
		const { token } = store.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const original = f.app.fleet.assertPublicationSourceCurrent.bind(
			f.app.fleet,
		);
		let checks = 0,
			denied = false;
		f.app.fleet.assertPublicationSourceCurrent = (id) => {
			checks++;
			if (denied) throw Error("Work source authority changed");
			original(id);
		};
		const url = `http://127.0.0.1:${f.app.port}/api/life/worlds/${worldId}/feed`,
			headers = { authorization: `Bearer ${token}` };
		expect((await fetch(url, { headers })).status).toBe(200);
		denied = true;
		expect((await fetch(url, { headers })).status).toBe(403);
		expect(checks).toBe(2);
		expect(f.models).toEqual([]);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test("publication HTTP reads and change notifications leave a cold fleet runtime unopened", async () => {
	const f = await fleetLifeFixture();
	try {
		const base = `http://127.0.0.1:${f.app.port}/api/life/worlds/missing`;
		expect((await fetch(`${base}/publication/settings`)).status).toBe(404);
		expect((await fetch(`${base}/feed`)).status).toBe(403);
		f.app.fleet.publicationChanged();
		expect(f.models).toEqual([]);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

for (const tier of [false, true])
	test(`fleet publishes through its owned runner (tier=${tier}) with public voice only, then replays after restart`, async () => {
		const f = await fleetLifeFixture();
		try {
			const profile = f.app.fleet.agents.get("lina");
			if (!profile) throw Error("Missing profile");
			f.app.fleet.agents.update("lina", profile.revision, {
				voice: "PUBLIC_FEED_VOICE",
				profile: "PRIVATE_BIO_NOT_FOR_POSTS",
			});
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
			const store = f.app.fleet.lifeStorage;
			if (tier) {
				const { revision: modelRevision, ...settings } =
					f.app.fleet.modelSettings.snapshot();
				f.app.fleet.modelSettings.replace(modelRevision, {
					...settings,
					routes: {
						version: 1,
						tiers: {
							quick: { profileId: "director" },
							standard: { profileId: "actor" },
							deep: { profileId: "director" },
							intensive: {
								profileId: "actor",
								reasoning: "medium",
								maxOutputTokens: 1024,
							},
						},
						roleTiers: {},
					},
				});
			}
			const { worldId, revision, ...config } = store.lifeConfig("test-world");
			store.setLifeConfig(worldId, revision, {
				...config,
				version: 2,
				work: config.version === 2 ? config.work : null,
				...(tier
					? {
							version: 2 as const,
							work: null,
							models: {
								director: config.models?.director ?? null,
								actor: { tier: "intensive" as const },
							},
						}
					: {}),
				publication: { mode: "manual", recipientIds: ["friends"] },
			});
			store.setPublicationSettings(worldId, 0, {
				version: 1,
				agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
				reactionIds: [],
				maxChainDepth: 8,
				maxActionsPerChain: 10,
				perAuthorCooldownSteps: 0,
				maxJobsPerRun: 1,
			});
			const runtime = f.app.fleet.lifeRuntime;
			expect(
				(
					await runtime.run(
						worldId,
						"source-event",
						2,
						new AbortController().signal,
					)
				).status,
			).toBe("accepted");
			const model = f.models[0];
			if (!model) throw Error("Missing owned model");
			let outboundChecks = 0;
			model.onComplete = async (prepared) => {
				f.selections[0]?.beforeOutbound?.(prepared.request);
				outboundChecks++;
				return model.result(prepared);
			};
			model.text = (request) => {
				if (request.lane !== "publication")
					throw Error("Unexpected new simulation request");
				const material = JSON.parse(request.input).material;
				return JSON.stringify({
					kind: "post",
					segments: [{ kind: "claim", claimId: material.claims[0].id }],
				});
			};
			const input = {
				requestKey: "publish-source",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual" as const,
			};
			const publish = async () => {
				const { mode: _mode, ...body } = input;
				const response = await fetch(
					`http://127.0.0.1:${f.app.port}/api/life/worlds/${worldId}/publication/run`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					},
				);
				expect(response.status).toBe(200);
				return (await response.json()) as PublicationRun;
			};
			const run = await publish();
			expect(run.outcomes).toEqual(["published"]);
			const request = model.requests.at(-1);
			if (!request || request.lane !== "publication")
				throw Error("Missing publication request");
			expect(request.version).toBe(3);
			if (request.version !== 3)
				throw Error("Missing frozen publication route");
			expect(request.selection).toMatchObject({
				profileId: "actor",
				model: "route/actor",
			});
			expect(
				store.publicationJob(worldId, request.jobId).modelSelection,
			).toEqual(request.selection);
			if (tier) {
				expect(request.selection.reasoning).toBe("medium");
				expect(request.limits.maxOutputTokens).toBe(1024);
			}
			expect(request).not.toHaveProperty("stepId");
			expect(request.input).toContain("PUBLIC_FEED_VOICE");
			expect(request.input).not.toContain("PRIVATE_BIO_NOT_FOR_POSTS");
			expect(request.input).not.toContain("PRIVATE_FLEET_DIRECTOR");
			expect(() => f.selections[0]?.selection(request)).toThrow();
			expect(() => f.selections[0]?.beforeOutbound?.(request)).toThrow();
			expect(outboundChecks).toBe(1);
			const priorCalls = model.requests.length;
			await f.restart();
			expect(await publish()).toEqual(run);
			expect(model.requests).toHaveLength(priorCalls);
			expect(f.models.slice(1).flatMap((next) => next.requests)).toEqual([]);
			expect(f.providerCalls).toBe(0);
		} finally {
			await f.close();
		}
	}, 20_000);

test("a manual fleet step wakes automatic publication using the same runner and does not schedule another simulation", async () => {
	const f = await fleetLifeFixture();
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
		const store = f.app.fleet.lifeStorage;
		const { worldId, revision, ...config } = store.lifeConfig("test-world");
		store.setLifeConfig(worldId, revision, {
			...config,
			publication: { mode: "automatic", recipientIds: ["friends"] },
		});
		store.setPublicationSettings(worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 8,
			maxActionsPerChain: 10,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		});
		const runtime = f.app.fleet.lifeRuntime,
			model = f.models[0];
		if (!model) throw Error("Missing model");
		const text = model.text;
		model.text = (request) =>
			request.lane === "publication" ? '{"kind":"no_post"}' : text(request);
		model.onComplete = async (prepared) => {
			f.selections[0]?.beforeOutbound?.(prepared.request);
			return model.result(prepared);
		};
		const completed = Promise.withResolvers<PublicationRun>();
		const advance = store.advancePublicationRun.bind(store);
		store.advancePublicationRun = (...args) => {
			const result = advance(...args);
			if (result.status === "completed") completed.resolve(result);
			return result;
		};
		const step = await runtime.run(
			worldId,
			"manual-source-auto-publish",
			2,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		const result = await completed.promise;
		await runtime.close();
		expect(result.input.mode).toBe("automatic");
		expect(result.outcomes).toEqual(["skipped"]);
		expect(
			model.requests.filter((request) => request.lane === "publication"),
		).toHaveLength(1);
		expect(store.lifeSnapshot(worldId).revision).toBe(1);
		expect(store.automaticPublicationInput(worldId)).toBeNull();
		expect(
			store.publicationExecutionStatus(worldId).schedule?.lease,
		).toBeNull();
		await f.restart();
		await f.app.fleet.lifeRuntime.close();
		expect(f.models.slice(1).flatMap((model) => model.requests)).toEqual([]);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
}, 20_000);
