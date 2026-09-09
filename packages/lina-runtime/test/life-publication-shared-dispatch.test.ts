import { expect, test } from "bun:test";
import type {
	PublicationModelRequest,
	StepModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../../lina-core/src/world/autonomy-views.ts";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../lina-core/src/world/publication-model.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

test.each(["step", "publication"] as const)(
	"real WorldStore %s uncertainty fences the other already-prepared owner across restart",
	async (first) => {
		const f = runtimeStoreFixture(false, (pack) => {
			for (const event of pack.autonomy.events) event.cooldownSteps = 0;
			pack.life.projection.disclosures.push({
				subject: { kind: "world_event", id: "test-world:1" },
				policy: {
					knowers: ["lina"],
					disclosures: [{ agentId: "lina", recipientId: "friends" }],
					publication: ["friends"],
				},
			});
		});
		let reopened: WorldStore | undefined;
		try {
			const worldId = "test-world",
				{ worldId: _w, revision, ...config } = f.store.lifeConfig(worldId);
			f.store.setLifeConfig(worldId, revision, {
				...config,
				publication: { mode: "manual", recipientIds: ["friends"] },
			});
			f.store.setPublicationSettings(worldId, 0, {
				version: 1,
				agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
				reactionIds: [],
				maxChainDepth: 10,
				maxActionsPerChain: 20,
				perAuthorCooldownSteps: 0,
				maxJobsPerRun: 1,
			});
			expect(
				(await f.runner.run(worldId, "event", 2, new AbortController().signal))
					.status,
			).toBe("accepted");
			const step = f.store.prepareLifeStep(
				{
					worldId,
					idempotencyKey: "prepared-step",
					expectedConfigRevision: 2,
					owner: "shared-owner",
					nowMs: f.clock.now(),
					leaseMs: 300,
					...f.options.identity(),
				},
				() => 42,
			);
			const run = f.store.beginPublicationRun(
				worldId,
				{
					requestKey: "prepared-publication",
					expectedConfigRevision: 2,
					expectedSettingsRevision: 1,
					mode: "manual",
				},
				"shared-owner",
				300,
			);
			const item = run.batch[0],
				lease = run.lease;
			if (!item || !lease || !step.decision.agentId)
				throw Error("Missing dual owner fixture");
			const job = f.store.freezePublicationJob(
				lease,
				run.id,
				item.jobId,
				publicationAuthor,
				1,
			);
			const limits = {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 100000,
				maxOutputBytes: 10000,
				timeoutMs: 1000,
			};
			if (
				!config.models?.director ||
				!config.models.actor ||
				"tier" in config.models.director ||
				"tier" in config.models.actor
			)
				throw Error("Missing routes");
			const sr: StepModelRequest = {
				version: 1,
				id: "dual-owner-step",
				worldId,
				stepId: step.id,
				lane: "director",
				agentId: step.decision.agentId,
				...config.models.director,
				modelSettingsRevision: 1,
				...buildLifeModelInput(step, "director", step.decision.agentId),
				limits,
			};
			const pr: PublicationModelRequest = {
				version: 2,
				id: publicationModelId(job.attemptId),
				worldId,
				jobId: job.id,
				lane: "publication",
				agentId: job.authorAgentId,
				...config.models.actor,
				modelSettingsRevision: 1,
				...buildPublicationModelInput(job),
				limits,
			};
			const prepared = (
				request: StepModelRequest | PublicationModelRequest,
			) => ({
				version: 1 as const,
				request,
				inputDigest: lifeDigest(request),
				capabilityFingerprint: "a".repeat(64),
				nativeReference: `native-${request.id}`,
			});
			f.store.prepareLifeModel(
				step.lease,
				step.id,
				prepared(sr),
				f.clock.now(),
			);
			f.store.preparePublicationModel(lease, run.id, prepared(pr));
			if (first === "step") {
				f.store.dispatchLifeModel(step.lease, step.id, sr.id, f.clock.now());
				f.store.finishLifeModel(
					worldId,
					step.id,
					sr.id,
					{ status: "unknown" },
					f.clock.now(),
				);
			} else {
				f.store.dispatchPublicationModel(lease, run.id, job.id, pr.id);
				f.store.finishPublicationModel(worldId, job.id, pr.id, {
					status: "unknown",
				});
			}
			expect(
				f.store.publicationExecutionStatus(worldId).usage.unknownRequests,
			).toBe(1);
			f.store.close();
			reopened = new WorldStore(f.path, () => f.clock.now());
			if (first === "step")
				expect(() =>
					reopened?.dispatchPublicationModel(lease, run.id, job.id, pr.id),
				).toThrow(/uncertain/);
			else
				expect(() =>
					reopened?.dispatchLifeModel(
						step.lease,
						step.id,
						sr.id,
						f.clock.now(),
					),
				).toThrow(/uncertain/);
			expect(
				reopened.publicationExecutionStatus(worldId).usage.unknownRequests,
			).toBe(1);
			expect(f.model.requests).toHaveLength(5);
		} finally {
			reopened?.close();
			await f.close();
		}
	},
	20000,
);
