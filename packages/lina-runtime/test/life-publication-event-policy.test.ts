import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { PublicationJobs } from "../../lina-core/src/world/publication-jobs.ts";
import { publicationJobId } from "../../lina-core/src/world/publication-record-validation.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { proposePack } from "../../lina-core/test/life-autonomy-migration-fixture.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const settings = {
	version: 2 as const,
	worldVersion: 1,
	agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
	reactionIds: [],
	maxChainDepth: 8,
	maxActionsPerChain: 20,
	perAuthorCooldownSteps: 0,
	maxJobsPerRun: 1,
	eventRules: [
		{
			familyId: "meet",
			authorAgentIds: ["lina"],
			recipientIds: ["friends"],
			summary: "Residents spent time together.",
		},
	],
};

test.each(["rules", "family"] as const)(
	"owner-authored policy serves future events and preserves history after removing %s and reopening",
	async (removal) => {
		const f = runtimeStoreFixture(false, (pack) => {
			pack.life.projection.disclosures = [];
			pack.autonomy.goals = [];
			for (const event of pack.autonomy.events) event.cooldownSteps = 0;
		});
		let publisher: ReturnType<typeof createLifeRunner> | undefined;
		let reopened: WorldStore | undefined;
		try {
			const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
			f.store.setLifeConfig(worldId, revision, {
				...config,
				publication: { mode: "manual", recipientIds: ["friends"] },
			});
			f.store.setPublicationSettings(worldId, 0, settings);
			const eventIds: string[] = [];
			for (const index of [0, 1]) {
				const step = await f.runner.run(
					worldId,
					`future-${index}`,
					2,
					new AbortController().signal,
				);
				expect(step.status).toBe("accepted");
				expect(step.decision.familyId).toBe("meet");
				const effect = step.outcome?.commit.effects[0];
				if (!effect) throw Error("Missing publication event");
				eventIds.push(effect.payload.eventId);
				const material = f.store.publicationMaterial(
					worldId,
					effect.id,
					"lina",
					["friends"],
					{ maxChars: 20000, maxRecords: 100 },
				);
				expect(material?.allowedClaims.map((claim) => claim.text)).toEqual([
					"Residents spent time together.",
				]);
				for (const absent of ["ACTOR_PRIVATE", "hidden key", "Private goal"])
					expect(JSON.stringify(material)).not.toContain(absent);
			}
			expect(new Set(eventIds).size).toBe(2);
			const priorText = f.model.text;
			f.model.text = (request) =>
				request.version === 2
					? JSON.stringify({
							kind: "post",
							segments: [
								{
									kind: "claim",
									claimId: JSON.parse(request.input).material.claims[0].id,
								},
							],
						})
					: priorText(request);
			publisher = createLifeRunner({
				...f.options,
				publication: { store: f.store, author: () => publicationAuthor },
			});
			const run = await publisher.publish(
				worldId,
				{
					mode: "manual",
					requestKey: "future-post",
					expectedConfigRevision: 2,
					expectedSettingsRevision: 1,
				},
				new AbortController().signal,
			);
			expect(run.outcomes).toEqual(["published"]);
			const jobId = run.batch[0]?.jobId;
			if (!jobId) throw Error("Missing published job");
			const job = f.store.publicationJob(worldId, jobId);
			const minted = f.store.mintPublicationViewer(worldId, {
				requestKey: "viewer",
				expectedSettingsRevision: 1,
				recipientId: "friends",
			});
			const principal = { kind: "viewer" as const, grantId: minted.grant.id };
			expect(
				f.store.publicationFeed(worldId, principal, { limit: 10, after: null })
					.items,
			).toHaveLength(1);
			if (removal === "rules")
				f.store.setPublicationSettings(worldId, 1, {
					...settings,
					eventRules: [],
				});
			else {
				if (!job.postId) throw Error("Missing post");
				const queued = f.store.replyToPublication(
					worldId,
					principal,
					job.postId,
					{
						requestKey: "before-removal",
						expectedPostRevision: 1,
						text: "REVOKED_FAMILY_REPLY",
					},
				);
				expect(queued.interaction?.observationIds).toHaveLength(1);
				const pack = f.store.worldPack(worldId);
				if (pack.schemaVersion !== 3) throw Error("Missing autonomous pack");
				pack.version++;
				pack.world.version++;
				pack.life.revision++;
				pack.eventFamilies = [];
				pack.autonomy.events = [];
				pack.autonomy.goals = [];
				pack.autonomy.quietWeight = 1;
				f.store.activateWorldDraft(proposePack(f.store, pack).confirmation);
				expect(
					f.store.publicationFeed(worldId, principal, {
						limit: 10,
						after: null,
					}).items,
				).toEqual([]);
				const next = await f.runner.run(
					worldId,
					"after-family-removal",
					f.store.lifeConfig(worldId).revision,
					new AbortController().signal,
				);
				expect(next.status).toBe("accepted");
				expect(next.source.publication?.records).toEqual([]);
				expect(JSON.stringify(next.outcome?.commit.claims)).not.toContain(
					"REVOKED_FAMILY_REPLY",
				);
			}
			expect(
				f.store.publicationFeed(worldId, principal, { limit: 10, after: null })
					.items,
			).toEqual([]);
			await publisher.close();
			f.store.close();
			reopened = new WorldStore(f.path, () => f.clock.now());
			expect(reopened.publicationJob(worldId, jobId)).toEqual(job);
			expect(
				reopened.publicationFeed(worldId, principal, { limit: 10, after: null })
					.items,
			).toEqual([]);
		} finally {
			await publisher?.close();
			reopened?.close();
			await f.close();
		}
	},
	20000,
);

test("future-event settings reject unknown family or actor without changing the saved revision", async () => {
	const f = runtimeStoreFixture(false);
	try {
		for (const eventRules of [
			settings.eventRules.map((rule) => ({ ...rule, familyId: "invented" })),
			settings.eventRules.map((rule) => ({
				...rule,
				authorAgentIds: ["invented"],
			})),
		])
			expect(() =>
				f.store.setPublicationSettings("test-world", 0, {
					...settings,
					eventRules,
				}),
			).toThrow();
		expect(f.store.publicationSettings("test-world")).toBeNull();
	} finally {
		await f.close();
	}
});

test("automatic batch keys follow durable pending order even when it differs from lexical job identity", async () => {
	const f = runtimeStoreFixture(false, (pack) => {
		pack.life.projection.disclosures = [];
		for (const event of pack.autonomy.events) event.cooldownSteps = 0;
	});
	let publisher: ReturnType<typeof createLifeRunner> | undefined;
	try {
		const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
		f.store.setLifeConfig(worldId, revision, {
			...config,
			publication: { mode: "automatic", recipientIds: ["friends"] },
		});
		f.store.setPublicationSettings(worldId, 0, settings);
		for (const index of [0, 1])
			expect(
				(
					await f.runner.run(
						worldId,
						`order-${index}`,
						2,
						new AbortController().signal,
					)
				).status,
			).toBe("accepted");
		const candidates = f.store
			.lifeEffects(worldId)
			.map((effect) => ({
				intentId: effect.id,
				jobId: publicationJobId(worldId, effect.id, "lina", "friends"),
			}))
			.sort((a, b) => b.jobId.localeCompare(a.jobId));
		expect(candidates).toHaveLength(2);
		const db = new DatabaseSync(f.path);
		try {
			db.exec("BEGIN IMMEDIATE");
			const jobs = new PublicationJobs(db);
			for (const candidate of candidates)
				jobs.discover(worldId, candidate.intentId, "lina", "friends");
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		f.model.text = () => '{"kind":"no_post"}';
		publisher = createLifeRunner({
			...f.options,
			publication: { store: f.store, author: () => publicationAuthor },
		});
		const keys = new Set<string>();
		for (const candidate of candidates) {
			const input = f.store.automaticPublicationInput(worldId);
			if (!input) throw Error("Missing pending candidate");
			expect(keys.has(input.requestKey)).toBe(false);
			keys.add(input.requestKey);
			const run = await publisher.publish(
				worldId,
				input,
				new AbortController().signal,
			);
			expect(run.batch.map((item) => item.jobId)).toEqual([candidate.jobId]);
			expect(run.outcomes).toEqual(["skipped"]);
		}
		expect(f.store.automaticPublicationInput(worldId)).toBeNull();
		expect(
			f.model.requests.filter((request) => request.version === 2),
		).toHaveLength(2);
	} finally {
		await publisher?.close();
		await f.close();
	}
}, 20000);
