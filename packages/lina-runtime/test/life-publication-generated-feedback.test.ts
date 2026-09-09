import { expect, test } from "bun:test";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { publicationAuthor } from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const worldId = "test-world",
	canary = "GENERATED_REPLY_ONLY_FOR_LINA";
const signal = () => new AbortController().signal;
async function fixture() {
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
	const { worldId: _world, revision, ...config } = f.store.lifeConfig(worldId);
	f.store.setLifeConfig(worldId, revision, {
		...config,
		publication: { mode: "manual", recipientIds: ["friends"] },
	});
	f.store.setPublicationSettings(worldId, 0, {
		version: 1,
		agentRecipients: [
			{ agentId: "lina", recipientId: "friends" },
			{ agentId: "mira", recipientId: "friends" },
		],
		reactionIds: [],
		maxChainDepth: 10,
		maxActionsPerChain: 30,
		perAuthorCooldownSteps: 0,
		maxJobsPerRun: 1,
	});
	const priorText = f.model.text;
	f.model.text = (request) =>
		request.lane === "publication"
			? JSON.stringify({
					kind: "post",
					segments: [
						{
							kind: "imaginative",
							text: JSON.parse(request.input).material.parent
								? canary
								: "A public day.",
						},
					],
				})
			: priorText(request);
	const runner = createLifeRunner({
		...f.options,
		publication: {
			store: f.store,
			author: (_world, agentId) => ({
				...publicationAuthor,
				agentId,
				name: agentId,
			}),
		},
	});
	try {
		expect((await runner.run(worldId, "event", 2, signal())).status).toBe(
			"accepted",
		);
		const first = await runner.publish(
			worldId,
			{
				requestKey: "root",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			signal(),
		);
		expect(first.outcomes).toEqual(["published"]);
		const second = await runner.publish(
			worldId,
			{
				requestKey: "reply",
				expectedConfigRevision: 2,
				expectedSettingsRevision: 1,
				mode: "manual",
			},
			signal(),
		);
		expect(second.outcomes).toEqual(["published"]);
		const item = second.batch[0];
		if (!item) throw Error("Missing generated reply");
		const job = f.store.publicationJob(worldId, item.jobId);
		if (job.version !== 2 || !job.postId)
			throw Error("Generated reply required");
		expect(job.authorAgentId).toBe("mira");
		const inputs = f.store
			.lifeInputs(worldId)
			.filter((input) => input.version === 3);
		expect(inputs).toHaveLength(1);
		return {
			...f,
			activeRunner: runner,
			postId: job.postId,
			input: inputs[0],
			async close() {
				await runner.close();
				await f.close();
			},
		};
	} catch (error) {
		await runner.close();
		await f.close();
		throw error;
	}
}

test("an agent-generated reply becomes a scoped uncertain experience in the next real v3 step and survives withdrawal plus restart", async () => {
	const f = await fixture();
	let reopened: WorldStore | undefined;
	try {
		const before = f.model.requests.length;
		const step = await f.activeRunner.run(worldId, "feedback", 2, signal());
		expect(step.status).toBe("accepted");
		expect(step.source.publication?.records).toHaveLength(1);
		expect(step.source.publication?.records[0]?.source).toMatchObject({
			postId: f.postId,
			principal: { kind: "agent", agentId: "mira" },
			recipientAgentId: "lina",
			action: {
				kind: "generated_reply",
				segments: [{ kind: "imaginative", text: canary }],
			},
		});
		const claim = step.outcome?.commit.claims.find((claim) =>
			claim.text.includes(canary),
		);
		expect(claim).toMatchObject({
			text: `[imaginative] ${canary}`,
			truth: "unknown",
			disclosure: { knowers: ["lina"], disclosures: [], publication: [] },
		});
		expect(
			step.outcome?.commit.experiences.find((experience) =>
				experience.claims.some((ref) => ref.id === claim?.id),
			),
		).toMatchObject({ agentId: "lina", channel: "told" });
		const requests = f.model.requests.slice(before);
		expect(
			requests.find(
				(request) => request.lane === "actor" && request.agentId === "lina",
			)?.input,
		).toContain(canary);
		for (const request of requests.filter(
			(request) => request.agentId !== "lina" && request.lane !== "director",
		))
			expect(request.input).not.toContain(canary);
		f.store.withdrawPublicationPost(worldId, f.postId, {
			requestKey: "withdraw-generated",
			expectedRevision: 1,
		});
		await f.activeRunner.close();
		f.store.close();
		reopened = new WorldStore(f.path, () => f.clock.now());
		expect(reopened.lifeStep(worldId, step.id)).toEqual(step);
		expect(
			reopened.publicationPost(
				worldId,
				{ kind: "agent", agentId: "lina" },
				f.postId,
			),
		).toBeNull();
	} finally {
		reopened?.close();
		await f.close();
	}
}, 20000);

test.each(["before_prepare", "after_prepare"] as const)(
	"withdrawing the generated child %s prevents later model evidence and experience consumption",
	async (when) => {
		const f = await fixture();
		try {
			const request = {
				worldId,
				idempotencyKey: "pending-feedback",
				expectedConfigRevision: 2,
				owner: "pending",
				nowMs: f.clock.now(),
				leaseMs: 300,
				...f.options.identity(),
			};
			const step =
				when === "after_prepare"
					? f.store.prepareLifeStep(request, () => 42)
					: null;
			if (step) expect(step.source.publication?.records).toHaveLength(1);
			const calls = f.model.requests.length;
			f.store.withdrawPublicationPost(worldId, f.postId, {
				requestKey: "withdraw-generated",
				expectedRevision: 1,
			});
			if (step) {
				expect(f.store.lifeStep(worldId, step.id).status).toBe("stale");
				expect(() =>
					f.store.assertPublicationEvidenceCurrent(worldId, step.id),
				).toThrow();
			}
			const fresh = f.store.prepareLifeStep(
				{ ...request, idempotencyKey: "after-withdrawal" },
				() => 42,
			);
			expect(fresh.source.publication?.records).toEqual([]);
			expect(
				f.store.lifeInputs(worldId).find((input) => input.id === f.input?.id)
					?.consumedLifeRevision,
			).toBeNull();
			expect(f.model.requests).toHaveLength(calls);
		} finally {
			await f.close();
		}
	},
	20000,
);
