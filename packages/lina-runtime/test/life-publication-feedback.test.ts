import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { PublicationModelRequest } from "../../lina-core/src/world/autonomy-types.ts";
import {
	buildPublicationModelInput,
	publicationModelId,
} from "../../lina-core/src/world/publication-model.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const signal = () => new AbortController().signal;
async function setup(maxActionsPerChain = 20) {
	const f = runtimeStoreFixture(false, (pack) => {
		for (const event of pack.autonomy.events) event.cooldownSteps = 0;
		pack.life.projection.disclosures.push({
			subject: { kind: "world_event", id: "test-world:1" },
			policy: {
				knowers: ["lina", "mira"],
				disclosures: [{ agentId: "lina", recipientId: "friends" }],
				publication: ["friends"],
			},
		});
	});
	try {
		const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
		f.store.setLifeConfig(worldId, revision, {
			...config,
			publication: { mode: "manual", recipientIds: ["friends"] },
		});
		f.store.setPublicationSettings(worldId, 0, {
			version: 1,
			agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
			reactionIds: [],
			maxChainDepth: 10,
			maxActionsPerChain,
			perAuthorCooldownSteps: 0,
			maxJobsPerRun: 1,
		});
		const event = await f.runner.run(worldId, "first-event", 2, signal());
		expect(event.status).toBe("accepted");
		const run = f.store.beginPublicationRun(
			worldId,
			{
				requestKey: "post-event",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			"publication-test",
			300,
		);
		const item = run.batch[0],
			lease = run.lease;
		if (!item || !lease) throw Error("Missing publication candidate");
		const job = f.store.freezePublicationJob(
			lease,
			run.id,
			item.jobId,
			publicationAuthor,
			1,
		);
		const route = config.models?.actor,
			claim = job.material?.allowedClaims[0];
		if (!route || "tier" in route || !claim)
			throw Error("Missing public source");
		const request: PublicationModelRequest = {
			version: 2,
			id: publicationModelId(job.attemptId),
			worldId,
			jobId: job.id,
			lane: "publication",
			agentId: job.authorAgentId,
			...route,
			modelSettingsRevision: 1,
			...buildPublicationModelInput(job),
			limits: {
				maxInputTokens: 100,
				maxOutputTokens: 100,
				maxInputBytes: 20000,
				maxOutputBytes: 10000,
				timeoutMs: 1000,
			},
		};
		const prepared = await f.model.prepare(request, signal());
		f.store.preparePublicationModel(lease, run.id, prepared);
		f.store.dispatchPublicationModel(lease, run.id, job.id, request.id);
		const prior = f.model.text;
		f.model.text = () =>
			JSON.stringify({
				kind: "post",
				segments: [{ kind: "claim", claimId: claim.id }],
			});
		try {
			const result = await f.model.complete(prepared, signal());
			f.store.finishPublicationModel(worldId, job.id, request.id, {
				status: "completed",
				result,
			});
		} finally {
			f.model.text = prior;
		}
		const posted = f.store.completePublicationJob(lease, run.id, job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		f.store.advancePublicationRun(lease, run.id, job.id);
		f.store.releaseLifeLease(lease, f.clock.now());
		if (!posted.postId) throw Error("Publication did not create a post");
		const { grant } = f.store.mintPublicationViewer(worldId, {
			requestKey: "viewer",
			expectedSettingsRevision: 1,
			recipientId: "friends",
		});
		const principal = { kind: "viewer" as const, grantId: grant.id };
		const reply = f.store.replyToPublication(
			worldId,
			principal,
			posted.postId,
			{
				requestKey: "feedback",
				expectedPostRevision: 1,
				text: "READER_FEEDBACK_ONLY_FOR_LINA",
			},
		);
		return { ...f, postId: posted.postId, principal, grant, reply };
	} catch (error) {
		await f.close();
		throw error;
	}
}

// Two full runner cycles and a complete startup audit need an integration-test timeout.
test("a real runner event publishes through synthetic receipts, then scoped feedback is consumed by its next v3 event and survives restart", async () => {
	const f = await setup();
	let reopened: WorldStore | undefined;
	try {
		const before = f.model.requests.length;
		const step = await f.runner.run(
			"test-world",
			"after-feedback",
			2,
			signal(),
		);
		expect(step.status).toBe("accepted");
		expect(step.version).toBe(3);
		expect(step.decision.parent).toBeNull();
		expect(step.source.publication?.records).toHaveLength(1);
		expect(step.outcome?.commit.consumedInputIds).toEqual(
			f.reply.interaction?.observationIds,
		);
		const requests = f.model.requests.slice(before);
		expect(
			requests.find((request) => request.lane === "director")?.input,
		).toContain("READER_FEEDBACK_ONLY_FOR_LINA");
		for (const request of requests.filter(
			(request) => request.agentId !== "lina",
		))
			expect(request.input).not.toContain("READER_FEEDBACK_ONLY_FOR_LINA");
		expect(requests.some((request) => request.agentId !== "lina")).toBe(true);
		const input = f.store.lifeInputs("test-world")[0];
		if (!input) throw Error("Missing persisted feedback input");
		if (!step.receipt) throw Error("Missing accepted step receipt");
		expect(input.consumedLifeRevision).toBe(step.receipt.lifeRevision);
		const experience = step.outcome?.commit.experiences.find((record) =>
			record.id.startsWith("feedback-"),
		);
		expect(experience?.agentId).toBe("lina");
		f.store.revokePublicationViewer("test-world", f.grant.id, {
			requestKey: "revoke",
			expectedRevision: 1,
		});
		f.store.withdrawPublicationPost("test-world", f.postId, {
			requestKey: "withdraw",
			expectedRevision: 1,
		});
		await f.runner.close();
		f.store.close();
		reopened = new WorldStore(f.path, () => f.clock.now());
		expect(reopened.lifeStep("test-world", step.id)).toEqual(step);
		expect(reopened.lifeInputs("test-world")).toEqual([input]);
		const current = reopened.prepareLifeStep(
			{
				worldId: "test-world",
				idempotencyKey: "after-reopen",
				expectedConfigRevision: 2,
				owner: "reopened",
				nowMs: f.clock.now(),
				leaseMs: 300,
				...f.options.identity(),
			},
			() => {
				throw Error("Do not reroll seed");
			},
		);
		expect(current.source.publication?.records).toEqual([]);
	} finally {
		reopened?.close();
		await f.close();
	}
}, 20_000);

test("reopen rejects an uncharged interaction whose observations remain queued behind a valid chain prefix", async () => {
	const f = await setup(2);
	try {
		await f.runner.close();
		f.store.close();
		const db = new DatabaseSync(f.path);
		try {
			const action = db
				.prepare(
					"SELECT action_key FROM life_publication_chain_actions WHERE world_id='test-world' AND sequence=2",
				)
				.get();
			const previous = db
				.prepare(
					"SELECT digest FROM life_publication_chain_actions WHERE world_id='test-world' AND sequence=1",
				)
				.get();
			if (!action || !previous)
				throw Error("Missing actual interaction charge");
			db.exec("BEGIN IMMEDIATE");
			db.prepare(
				"DELETE FROM life_publication_chain_charges WHERE world_id='test-world' AND action_key=?",
			).run(String(action["action_key"]));
			db.prepare(
				"DELETE FROM life_publication_chain_actions WHERE world_id='test-world' AND action_key=?",
			).run(String(action["action_key"]));
			db.exec(
				"UPDATE life_publication_chain_roots SET action_count=1 WHERE world_id='test-world'",
			);
			db.prepare(
				"UPDATE life_publication_chain_state SET action_count=1,digest=? WHERE world_id='test-world'",
			).run(String(previous["digest"]));
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		expect(() => new WorldStore(f.path, () => f.clock.now()).close()).toThrow(
			"Missing publication interaction activity receipt",
		);
	} finally {
		await f.close();
	}
});

test("interaction recovery uses its original settings after the current allowance is lowered", async () => {
	const f = await setup(3);
	let reopened: WorldStore | undefined;
	try {
		const settings = f.store.publicationSettings("test-world");
		if (!settings) throw Error("Missing settings");
		const { worldId, revision, ...input } = settings;
		f.store.setPublicationSettings(worldId, revision, {
			...input,
			maxActionsPerChain: 1,
		});
		expect(f.reply.interaction?.settingsRevision).toBe(1);
		await f.runner.close();
		f.store.close();
		reopened = new WorldStore(f.path, () => f.clock.now());
		expect(reopened.publicationSettings(worldId)?.revision).toBe(2);
		const step = reopened.prepareLifeStep(
			{
				worldId,
				idempotencyKey: "lower-budget",
				expectedConfigRevision: 2,
				owner: "reopened",
				nowMs: f.clock.now(),
				leaseMs: 300,
				...f.options.identity(),
			},
			() => {
				throw Error("No new seed");
			},
		);
		expect(step.source.publicationBudget?.chain.revision).toBe(2);
		expect(step.source.publicationBudget?.blockedInputIds).toEqual(
			f.reply.interaction?.observationIds,
		);
	} finally {
		reopened?.close();
		await f.close();
	}
});

test("exhausted feedback stays unconsumed and out of later model input while independent LIFE can advance", async () => {
	const f = await setup(2);
	let reopened: WorldStore | undefined;
	try {
		const before = f.model.requests.length;
		const step = await f.runner.run(
			"test-world",
			"exhausted-feedback",
			2,
			signal(),
		);
		expect(step.status).toBe("accepted");
		expect(step.source.publicationBudget?.blockedInputIds).toEqual(
			f.reply.interaction?.observationIds,
		);
		expect(step.outcome?.commit.consumedInputIds).toEqual([]);
		for (const request of f.model.requests.slice(before))
			expect(request.input).not.toContain("READER_FEEDBACK_ONLY_FOR_LINA");
		expect(f.model.requests.length).toBeGreaterThan(before);
		expect(
			f.store.lifeInputs("test-world")[0]?.consumedLifeRevision,
		).toBeNull();
		await f.runner.close();
		f.store.close();
		reopened = new WorldStore(f.path, () => f.clock.now());
		expect(reopened.lifeStep("test-world", step.id)).toEqual(step);
		expect(
			reopened.lifeInputs("test-world")[0]?.consumedLifeRevision,
		).toBeNull();
	} finally {
		reopened?.close();
		await f.close();
	}
}, 20_000);

test("revoking the original viewer fences an already prepared feedback step without consuming its input", async () => {
	const f = await setup();
	try {
		const request = {
			worldId: "test-world",
			idempotencyKey: "pending-feedback",
			expectedConfigRevision: 2,
			owner: "pending",
			nowMs: f.clock.now(),
			leaseMs: 300,
			...f.options.identity(),
		};
		const step = f.store.prepareLifeStep(request, () => {
			throw Error("Do not reroll seed");
		});
		expect(step.source.publication?.records).toHaveLength(1);
		f.store.revokePublicationViewer("test-world", f.grant.id, {
			requestKey: "revoke",
			expectedRevision: 1,
		});
		expect(f.store.lifeStep("test-world", step.id).status).toBe("stale");
		expect(
			f.store.lifeInputs("test-world")[0]?.consumedLifeRevision,
		).toBeNull();
		const fresh = f.store.prepareLifeStep(
			{ ...request, idempotencyKey: "fresh" },
			() => {
				throw Error("Do not reroll seed");
			},
		);
		expect(fresh.source.publication?.records).toEqual([]);
	} finally {
		await f.close();
	}
});

test("new spending on a prepared feedback root fences dispatch and permits fresh budget capture", async () => {
	const f = await setup(4);
	try {
		const request = {
			worldId: "test-world",
			idempotencyKey: "old-budget",
			expectedConfigRevision: 2,
			owner: "pending",
			nowMs: f.clock.now(),
			leaseMs: 300,
			...f.options.identity(),
		};
		const step = f.store.prepareLifeStep(request, () => {
			throw Error("No new seed");
		});
		expect(step.source.publicationBudget?.chain.revision).toBe(2);
		f.store.replyToPublication(
			"test-world",
			{ kind: "viewer", grantId: f.grant.id },
			f.postId,
			{
				requestKey: "another-reply",
				expectedPostRevision: 1,
				text: "Another reader input",
			},
		);
		expect(f.store.lifeStep("test-world", step.id).status).toBe("stale");
		expect(() =>
			f.store.assertPublicationEvidenceCurrent("test-world", step.id),
		).toThrow("Stale publication budget");
		expect(
			f.store
				.lifeInputs("test-world")
				.every((input) => input.consumedLifeRevision === null),
		).toBe(true);
		const fresh = f.store.prepareLifeStep(
			{ ...request, idempotencyKey: "new-budget" },
			() => {
				throw Error("No new seed");
			},
		);
		expect(fresh.source.publicationBudget?.chain.revision).toBe(3);
		expect(fresh.source.publicationBudget?.blockedInputIds).toEqual([]);
		expect(fresh.lease.generation).toBeGreaterThan(step.lease.generation);
	} finally {
		await f.close();
	}
});

test("reopen rejects a removed causal charge even when remaining chain counters form a valid prefix", async () => {
	const f = await setup(3);
	try {
		const step = await f.runner.run(
			"test-world",
			"last-chain-action",
			2,
			signal(),
		);
		expect(step.status).toBe("accepted");
		expect(step.outcome?.commit.consumedInputIds).toEqual(
			f.reply.interaction?.observationIds,
		);
		await f.runner.close();
		f.store.close();
		const db = new DatabaseSync(f.path);
		try {
			const action = db
				.prepare(
					"SELECT action_key FROM life_publication_chain_actions WHERE world_id='test-world' AND sequence=3",
				)
				.get();
			const previous = db
				.prepare(
					"SELECT digest FROM life_publication_chain_actions WHERE world_id='test-world' AND sequence=2",
				)
				.get();
			if (!action || !previous) throw Error("Missing actual charged step");
			db.exec("BEGIN IMMEDIATE");
			db.prepare(
				"DELETE FROM life_publication_chain_charges WHERE world_id='test-world' AND action_key=?",
			).run(String(action["action_key"]));
			db.prepare(
				"DELETE FROM life_publication_chain_actions WHERE world_id='test-world' AND action_key=?",
			).run(String(action["action_key"]));
			db.exec(
				"UPDATE life_publication_chain_roots SET action_count=2 WHERE world_id='test-world'",
			);
			db.prepare(
				"UPDATE life_publication_chain_state SET action_count=2,digest=? WHERE world_id='test-world'",
			).run(String(previous["digest"]));
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		expect(() => new WorldStore(f.path, () => f.clock.now()).close()).toThrow(
			"Missing publication causal activity receipt",
		);
	} finally {
		await f.close();
	}
}, 20_000);
