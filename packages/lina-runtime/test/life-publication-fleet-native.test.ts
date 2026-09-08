import { expect, test } from "bun:test";
import { createCodexLifeModel } from "../../lina-codex/src/life-model.ts";
import { lifeResponse } from "../../lina-codex/test/life-model-fixture.ts";
import type {
	PublicationRun,
	PublicLifePost,
} from "../../lina-core/src/world/publication-types.ts";
import type { WorldStore } from "../../lina-core/src/world/store.ts";
import { emptyReflection } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { startWebServer } from "../../lina-web/src/server.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
for (const deny of [false, true])
	nativeTest(
		`native Fleet publication ${deny ? "rejects revoked settings before fetch" : "publishes an event and generated reply once"} and replays after full restart`,
		async () => {
			let store: WorldStore | undefined;
			let publicationChecks = 0;
			let viewerReceipt: { token: string; post: PublicLifePost } | undefined;
			let generatedRun: PublicationRun | undefined;
			let generatedPost: PublicLifePost | undefined;
			const bodies: unknown[] = [];
			const f = await fleetLifeFixture(
				{
					createLifeModel(options) {
						return createCodexLifeModel({
							...options,
							beforeOutbound(request) {
								if (request.version === 2) {
									publicationChecks++;
									if (deny) {
										const settings = store?.publicationSettings(
											request.worldId,
										);
										if (!store || !settings || settings.version !== 2)
											throw Error("Missing publication settings");
										const { worldId, revision, ...input } = settings;
										store.setPublicationSettings(worldId, revision, {
											...input,
											eventRules: [],
										});
									}
								}
								options.beforeOutbound?.(request);
							},
						});
					},
				},
				async (request) => {
					expect(new URL(request.url).pathname).toBe("/v1/responses");
					bodies.push(await request.json());
					const text =
						bodies.length === 1
							? "PRIVATE_NATIVE_DIRECTOR"
							: bodies.length === 2
								? JSON.stringify(socialIntent())
								: bodies.length === 3
									? JSON.stringify({
											intentId: "intent-1",
											agentId: "mira",
											decision: "accept",
										})
									: bodies.length <= 5
										? JSON.stringify(emptyReflection())
										: JSON.stringify({
												kind: "post",
												segments: [
													{
														kind: "imaginative",
														text: "A quiet moment after meeting a friend.",
													},
												],
											});
					return lifeResponse(text);
				},
			);
			try {
				f.setup(false, false, (pack) => {
					pack.life.projection.disclosures = [];
				});
				store = f.app.fleet.lifeStorage;
				const { worldId, revision, ...config } = store.lifeConfig("test-world");
				store.setLifeConfig(worldId, revision, {
					...config,
					publication: { mode: "manual", recipientIds: ["friends"] },
				});
				store.setPublicationSettings(worldId, 0, {
					version: 2,
					worldVersion: 1,
					eventRules: [
						{
							familyId: "meet",
							authorAgentIds: ["lina"],
							recipientIds: ["friends"],
							summary: "Residents spent time together.",
						},
					],
					agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
					reactionIds: [],
					maxChainDepth: 8,
					maxActionsPerChain: 10,
					perAuthorCooldownSteps: 0,
					maxJobsPerRun: 1,
				});
				const profile = f.app.fleet.agents.get("lina");
				if (!profile) throw Error("Missing profile");
				f.app.fleet.agents.update("lina", profile.revision, {
					voice: "PUBLIC_NATIVE_FEED_VOICE",
					profile: "PRIVATE_NATIVE_BIO",
				});
				const post = (action: string, body: unknown) =>
					fetch(
						`http://127.0.0.1:${f.app.port}/api/life/worlds/${worldId}/${action}`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						},
					);
				const step = await post("step", {
					idempotencyKey: "native-source",
					expectedConfigRevision: 2,
				});
				expect(step.status).toBe(200);
				expect(await step.json()).toMatchObject({ status: "accepted" });
				expect(bodies).toHaveLength(5);
				const input = {
					requestKey: "native-publish",
					expectedConfigRevision: 2,
					expectedSettingsRevision: 1,
				};
				const response = await post("publication/run", input);
				expect(response.status).toBe(200);
				const run = (await response.json()) as PublicationRun;
				expect(run.status).toBe("completed");
				expect(run.outcomes).toEqual([deny ? "failed" : "published"]);
				expect(publicationChecks).toBe(1);
				expect(bodies).toHaveLength(deny ? 5 : 6);
				const item = run.batch[0];
				if (!item) throw Error("Missing publication job");
				const record = store.publicationModelRecords(worldId, item.jobId)[0];
				expect(record?.status).toBe(deny ? "failed" : "completed");
				expect(record?.upstreamAttempts).toBe(deny ? 0 : 1);
				if (!deny) {
					const wire = JSON.stringify(bodies[5]);
					expect(wire).toContain("PUBLIC_NATIVE_FEED_VOICE");
					expect(wire).toContain("Residents spent time together.");
					for (const secret of [
						"PRIVATE_NATIVE_BIO",
						"PRIVATE_NATIVE_DIRECTOR",
						"memory_search",
						"exec_command",
					])
						expect(wire).not.toContain(secret);
					const issued = store.mintPublicationViewer(worldId, {
						requestKey: "native-viewer",
						expectedSettingsRevision: 1,
						recipientId: "friends",
					});
					if (!issued.token) throw Error("Missing newly minted token");
					const web = startWebServer({
						port: 0,
						upstream: `ws://127.0.0.1:${f.app.port}/ws`,
						assets: { html: "ok", script: "", css: "", icon: "" },
					});
					try {
						const origin = `http://127.0.0.1:${web.port}`;
						const feedUrl = `${origin}/api/life/worlds/${worldId}/feed`;
						const headers = { authorization: `Bearer ${issued.token}`, origin };
						const feed = await fetch(feedUrl, { headers });
						expect(feed.status).toBe(200);
						const publicFeed = (await feed.json()) as ReturnType<
							WorldStore["publicationFeed"]
						>;
						expect(publicFeed.items).toHaveLength(1);
						expect(publicFeed.items[0]?.segments).toEqual([
							{
								kind: "imaginative",
								text: "A quiet moment after meeting a friend.",
							},
						]);
						const parent = publicFeed.items[0];
						if (!parent) throw Error("Missing visible post");
						const reply = () =>
							fetch(`${feedUrl}/posts/${parent.id}/replies`, {
								method: "POST",
								headers: { ...headers, "content-type": "application/json" },
								body: JSON.stringify({
									requestKey: "native-viewer-reply",
									expectedPostRevision: parent.revision,
									text: "See you tomorrow",
								}),
							});
						const first = await reply();
						expect(first.status).toBe(200);
						const firstBody = (await first.json()) as {
							post: PublicLifePost | null;
							replayed: boolean;
						};
						expect(firstBody.replayed).toBe(false);
						if (!firstBody.post) throw Error("Missing public reply");
						viewerReceipt = { token: issued.token, post: firstBody.post };
						const duplicate = await reply();
						expect(duplicate.status).toBe(200);
						expect(await duplicate.json()).toMatchObject({
							post: firstBody.post,
							replayed: true,
						});
						expect(store.lifeSnapshot(worldId).revision).toBe(1);
						expect((await fetch(feedUrl)).status).toBe(403);
						const generatedResponse = await post("publication/run", {
							...input,
							requestKey: "native-generated-reply",
						});
						expect(generatedResponse.status).toBe(200);
						generatedRun = (await generatedResponse.json()) as PublicationRun;
						expect(generatedRun.outcomes).toEqual(["published"]);
						const generatedItem = generatedRun.batch[0];
						if (!generatedItem) throw Error("Missing generated native job");
						const generated = store.publicationJob(
							worldId,
							generatedItem.jobId,
						);
						expect(generated.version).toBe(2);
						if (!generated.postId) throw Error("Missing generated native post");
						const detail = await fetch(`${feedUrl}/posts/${generated.postId}`, {
							headers,
						});
						expect(detail.status).toBe(200);
						generatedPost = (await detail.json()) as PublicLifePost;
						expect(generatedPost).toMatchObject({
							kind: "reply",
							parentPostId: firstBody.post.id,
							author: { kind: "agent", agentId: "lina" },
						});
						const replyWire = JSON.stringify(bodies[6]);
						expect(replyWire).toContain("See you tomorrow");
						expect(replyWire).toContain("no_reply");
						for (const secret of [
							"PRIVATE_NATIVE_BIO",
							"PRIVATE_NATIVE_DIRECTOR",
							"Residents spent time together.",
							"exec_command",
						])
							expect(replyWire).not.toContain(secret);
					} finally {
						await web.stop(true);
					}
				}
				await f.restart();
				store = f.app.fleet.lifeStorage;
				if (viewerReceipt) {
					const reply = await fetch(
						`http://127.0.0.1:${f.app.port}/api/life/worlds/${worldId}/feed/posts/${viewerReceipt.post.id}`,
						{ headers: { authorization: `Bearer ${viewerReceipt.token}` } },
					);
					expect(reply.status).toBe(200);
					expect(await reply.json()).toEqual(viewerReceipt.post);
					if (generatedPost && generatedRun) {
						const detail = await fetch(
							`http://127.0.0.1:${f.app.port}/api/life/worlds/${worldId}/feed/posts/${generatedPost.id}`,
							{ headers: { authorization: `Bearer ${viewerReceipt.token}` } },
						);
						expect(await detail.json()).toEqual(generatedPost);
						expect(
							await (
								await post("publication/run", {
									...input,
									requestKey: "native-generated-reply",
								})
							).json(),
						).toEqual(generatedRun);
					}
				}
				expect(await (await post("publication/run", input)).json()).toEqual(
					run,
				);
				expect(publicationChecks).toBe(deny ? 1 : 2);
				expect(f.providerCalls).toBe(deny ? 5 : 7);
				expect(store.publicationModelRecords(worldId, item.jobId)[0]).toEqual(
					record,
				);
			} finally {
				await f.close();
			}
		},
		60000,
	);
