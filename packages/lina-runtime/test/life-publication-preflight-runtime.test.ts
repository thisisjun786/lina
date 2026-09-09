import { expect, test } from "bun:test";
import { createCodexLifeModel } from "../../lina-codex/src/life-model.ts";
import { lifeResponse } from "../../lina-codex/test/life-model-fixture.ts";
import { emptyReflection } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
nativeTest(
	"native publication credential failure releases usage across Fleet restart and permits one explicit new attempt",
	async () => {
		let credentialAvailable = false,
			calls = 0;
		const f = await fleetLifeFixture(
			{
				createLifeModel(options) {
					return createCodexLifeModel({
						...options,
						selection(request) {
							const selected = options.selection(request);
							return request.lane === "publication"
								? {
										...selected,
										connection: {
											...selected.connection,
											requiresAdmissionToken: true,
										},
									}
								: selected;
						},
						providerEnv: () => ({
							...options.providerEnv?.(),
							OPENCODEX_API_AUTH_TOKEN: credentialAvailable
								? "synthetic-local-admission"
								: "",
						}),
					});
				},
			},
			async (request) => {
				calls++;
				await request.json();
				const text =
					calls === 1
						? "Director"
						: calls === 2
							? JSON.stringify(socialIntent())
							: calls === 3
								? JSON.stringify({
										intentId: "intent-1",
										agentId: "mira",
										decision: "accept",
									})
								: calls <= 5
									? JSON.stringify(emptyReflection())
									: JSON.stringify({
											kind: "post",
											segments: [
												{ kind: "imaginative", text: "A public moment." },
											],
										});
				return lifeResponse(text);
			},
		);
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
				store = f.app.fleet.lifeStorage,
				{ worldId: _world, revision, ...config } = store.lifeConfig(worldId);
			store.setLifeConfig(worldId, revision, {
				...config,
				publication: { mode: "manual", recipientIds: ["friends"] },
			});
			store.setPublicationSettings(worldId, 0, {
				version: 1,
				agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
				reactionIds: [],
				maxChainDepth: 3,
				maxActionsPerChain: 10,
				perAuthorCooldownSteps: 0,
				maxJobsPerRun: 1,
			});
			expect(
				(
					await f.app.fleet.lifeRuntime.run(
						worldId,
						"event",
						2,
						new AbortController().signal,
					)
				).status,
			).toBe("accepted");
			const input = {
				requestKey: "failed-local-preflight",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual" as const,
			};
			const run = await f.app.fleet.lifeRuntime.publish(
				worldId,
				input,
				new AbortController().signal,
			);
			expect(run.status).toBe("completed");
			expect(run.outcomes).toEqual(["failed"]);
			expect(calls).toBe(5);
			const item = run.batch[0];
			if (!item) throw Error("Missing failed job");
			const failed = store.publicationJob(worldId, item.jobId);
			expect(
				store.publicationModelRecords(worldId, item.jobId)[0],
			).toMatchObject({
				status: "failed",
				upstreamAttempts: 0,
				usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			});
			expect(store.publicationExecutionStatus(worldId).usage).toMatchObject({
				unknownRequests: 0,
				reservedInputTokens: 0,
				reservedOutputTokens: 0,
			});
			await f.restart();
			const reopened = f.app.fleet.lifeStorage;
			expect(reopened.publicationJob(worldId, item.jobId)).toEqual(failed);
			credentialAvailable = true;
			expect(
				await f.app.fleet.lifeRuntime.publish(
					worldId,
					input,
					new AbortController().signal,
				),
			).toEqual(run);
			expect(calls).toBe(5);
			const retried = reopened.retryPublicationJob(worldId, item.jobId, {
				requestKey: "retry",
				expectedRevision: failed.revision,
			});
			expect(retried.attempt).toBe(2);
			const next = await f.app.fleet.lifeRuntime.publish(
				worldId,
				{ ...input, requestKey: "explicit-retry" },
				new AbortController().signal,
			);
			expect(next.outcomes).toEqual(["published"]);
			expect(calls).toBe(6);
			expect(
				reopened.publicationModelRecords(worldId, item.jobId),
			).toHaveLength(2);
		} finally {
			await f.close();
		}
	},
	60000,
);
