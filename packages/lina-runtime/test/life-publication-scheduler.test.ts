import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { autonomySource } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { publicationStoreFixture } from "../../lina-core/test/life-publication-store-fixture.ts";
import { visitLifePublication } from "../src/life/publication-scheduler.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { createLifeRuntime } from "../src/life/runtime.ts";
import { createEnsembleSocialEngine } from "../src/life/social/ensemble.ts";
import {
	RuntimeClock,
	RuntimeForeground,
	RuntimeModel,
} from "./life-runtime-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

test("automatic publication drains a real candidate once, then reads and restart do not redispatch or create empty runs", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-schedule-"));
	const path = join(root, "world.sqlite");
	publicationStoreFixture(path).close();
	const clock = new RuntimeClock();
	clock.time = 1000;
	let store = new WorldStore(path, () => clock.now());
	const model = new RuntimeModel();
	model.text = () => '{"kind":"no_post"}';
	const source = autonomySource();
	const makeRunner = () =>
		createLifeRunner({
			store,
			model,
			clock,
			foreground: new RuntimeForeground(),
			engine: createEnsembleSocialEngine(),
			identity: () => ({
				identity: source.identity,
				profiles: source.profiles,
				modelSettingsRevision: 1,
			}),
			publication: { store, author: () => publicationAuthor },
		});
	let runner = makeRunner();
	const visit = () =>
		visitLifePublication(
			{ store, runner, clock },
			"test-world",
			new AbortController().signal,
		);
	try {
		const input = store.automaticPublicationInput("test-world");
		expect(input).not.toBeNull();
		expect(await visit()).toBeNull();
		expect(model.requests).toHaveLength(1);
		expect(model.requests[0]?.version).toBe(2);
		expect(store.automaticPublicationInput("test-world")).toBeNull();
		expect(await visit()).toBeNull();
		expect(model.requests).toHaveLength(1);
		expect(
			store.publicationExecutionStatus("test-world").schedule?.lease,
		).toBeNull();
		await runner.close();
		store.close();
		store = new WorldStore(path, () => clock.now());
		runner = makeRunner();
		expect(await visit()).toBeNull();
		expect(model.requests).toHaveLength(1);
	} finally {
		await runner.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a live lease supplies the wake deadline and configured zero token capacity stays idle", async () => {
	const store = publicationStoreFixture();
	const clock = new RuntimeClock();
	clock.time = 1000;
	let calls = 0;
	const runner = {
		async publishScheduled() {
			calls++;
			throw Error("Must not call");
		},
	};
	try {
		const lease = store.acquireLifeLease("test-world", 1, "other", 1000, 100);
		expect(
			await visitLifePublication(
				{ store, runner, clock },
				"test-world",
				new AbortController().signal,
			),
		).toBe(1100);
		store.releaseLifeLease(lease, 1000);
		const { worldId, revision, ...config } = store.lifeConfig("test-world");
		if (!config.usage) throw Error("Missing usage");
		store.setLifeConfig(worldId, revision, {
			...config,
			usage: { ...config.usage, maxInputTokens: 0 },
		});
		expect(
			await visitLifePublication(
				{ store, runner, clock },
				"test-world",
				new AbortController().signal,
			),
		).toBeNull();
		expect(store.pendingPublicationRuns(worldId)).toEqual([]);
		expect(calls).toBe(0);
	} finally {
		store.close();
	}
});

test("runtime startup drains an older LIFE publication world without an autonomous pack or director model", async () => {
	const store = publicationStoreFixture();
	const clock = new RuntimeClock();
	clock.time = 1000;
	const model = new RuntimeModel();
	model.text = () => '{"kind":"no_post"}';
	const source = autonomySource();
	const errors: unknown[] = [];
	const done = Promise.withResolvers<void>();
	const advance = store.advancePublicationRun.bind(store);
	store.advancePublicationRun = (...args) => {
		const result = advance(...args);
		if (result.status === "completed") done.resolve();
		return result;
	};
	const runtime = createLifeRuntime({
		store,
		model,
		clock,
		foreground: new RuntimeForeground(),
		engine: createEnsembleSocialEngine(),
		worldIds: () => [],
		publicationWorldIds: () => ["test-world"],
		config: (world) => store.lifeConfig(world),
		acquireLease: (...args) => store.acquireLifeLease(...args),
		onError: (_world, error) => {
			errors.push(error);
			done.reject(error);
		},
		identity: () => ({
			identity: source.identity,
			profiles: source.profiles,
			modelSettingsRevision: 1,
		}),
		publication: { store, author: () => publicationAuthor },
	});
	try {
		expect(
			store.worldCatalog({ limit: 10, afterId: null }).items[0]?.packVersion,
		).toBeNull();
		expect(store.lifeConfig("test-world").models?.director).toBeNull();
		runtime.start();
		await done.promise;
		await runtime.close();
		expect(errors).toEqual([]);
		expect(model.requests).toHaveLength(1);
		expect(model.requests[0]?.version).toBe(2);
		expect(store.lifeSnapshot("test-world").revision).toBe(1);
		expect(store.pendingPublicationRuns("test-world")).toEqual([]);
	} finally {
		await runtime.close();
		store.close();
	}
});

test("known exhausted shared usage schedules its configured window before discovering another attempt", async () => {
	const f = preparedPublicationFixture(":memory:");
	const clock = new RuntimeClock();
	clock.time = 1000;
	let calls = 0;
	const runner = {
		async publishScheduled() {
			calls++;
			throw Error("Budget must wait");
		},
	};
	try {
		f.store.dispatchPublicationModel(
			f.lease,
			f.run.id,
			f.job.id,
			f.prepared.request.id,
		);
		f.store.finishPublicationModel(
			"test-world",
			f.job.id,
			f.prepared.request.id,
			{
				status: "failed",
				reason: "known_failure",
				usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				upstreamAttempts: 1,
			},
		);
		const failed = f.store.publicationJob("test-world", f.job.id);
		expect(failed.status).toBe("failed");
		f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
		f.store.releaseLifeLease(f.lease, 1000);
		f.store.retryPublicationJob("test-world", f.job.id, {
			expectedRevision: failed.revision,
			requestKey: "explicit-retry",
		});
		const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
		if (!config.usage) throw Error("Missing budget");
		f.store.setLifeConfig(worldId, revision, {
			...config,
			usage: { ...config.usage, maxInputTokens: 10, maxOutputTokens: 5 },
		});
		expect(
			await visitLifePublication(
				{ store: f.store, runner, clock },
				worldId,
				new AbortController().signal,
			),
		).toBe(2000);
		expect(calls).toBe(0);
		expect(f.store.pendingPublicationRuns(worldId)).toEqual([]);
	} finally {
		f.store.close();
	}
});

test("paused unknown publication resumes only its saved batch for reconciliation and returns no immediate wake", async () => {
	const f = preparedPublicationFixture(":memory:");
	const clock = new RuntimeClock();
	clock.time = 1000;
	let calls = 0;
	try {
		f.store.dispatchPublicationModel(
			f.lease,
			f.run.id,
			f.job.id,
			f.prepared.request.id,
		);
		f.store.finishPublicationModel(
			"test-world",
			f.job.id,
			f.prepared.request.id,
			{ status: "unknown" },
		);
		f.store.releaseLifeLease(f.lease, 1000);
		const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
		f.store.setLifeConfig(worldId, revision, {
			...config,
			run: { mode: "paused" },
		});
		const runner = {
			async publishScheduled(_world: string, input: typeof f.run.input) {
				calls++;
				expect(input).toEqual(f.run.input);
				return f.run;
			},
		};
		expect(
			await visitLifePublication(
				{ store: f.store, runner, clock },
				worldId,
				new AbortController().signal,
			),
		).toBeNull();
		expect(calls).toBe(1);
		expect(
			f.store.publicationExecutionStatus(worldId).usage.unknownRequests,
		).toBe(1);
	} finally {
		f.store.close();
	}
});

async function queuedSimulationFixture() {
	const f = runtimeStoreFixture(false, (pack) => {
		pack.life.projection.disclosures = [];
		pack.autonomy.goals = [];
		for (const event of pack.autonomy.events) event.cooldownSteps = 0;
	});
	try {
		const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
		if (!config.clock) throw Error("Missing simulation clock");
		f.store.setLifeConfig(worldId, revision, {
			...config,
			run: { mode: "automatic" },
			clock: { ...config.clock, maxCatchUpSteps: 2 },
			publication: { mode: "automatic", recipientIds: ["friends"] },
		});
		f.store.setPublicationSettings(worldId, 0, {
			version: 2,
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
		});
		const seed = await f.runner.run(
			worldId,
			"queued-event",
			2,
			new AbortController().signal,
		);
		expect(seed.status).toBe("accepted");
		expect(f.store.automaticPublicationInput(worldId)).not.toBeNull();
		return f;
	} catch (error) {
		await f.close();
		throw error;
	}
}

test.each(["last_tokens", "catch_up"] as const)(
	"queued publication has priority over simulation with %s and a finite next wake",
	async (scenario) => {
		const f = await queuedSimulationFixture();
		const errors: unknown[] = [];
		const failed = Promise.withResolvers<never>();
		const probe = f.store.automaticPublicationInput.bind(f.store);
		let probes = 0;
		f.store.automaticPublicationInput = (worldId) => {
			if (++probes > 32)
				throw Error(
					`Publication queue did not quiesce: ${f.model.requests.map((request) => request.lane).join(",")}`,
				);
			return probe(worldId);
		};
		const runtime = createLifeRuntime({
			...f.options,
			worldIds: () => ["test-world"],
			config: (worldId) => f.store.lifeConfig(worldId),
			acquireLease: (...args) => f.store.acquireLifeLease(...args),
			onError: (_world, error) => {
				errors.push(error);
				failed.reject(error);
			},
			publication: { store: f.store, author: () => publicationAuthor },
		});
		try {
			const baseline = f.model.requests.length;
			const firstCall = Promise.withResolvers<string>();
			f.model.onComplete = async (prepared) => {
				firstCall.resolve(prepared.request.lane);
				return f.model.result(prepared);
			};
			const priorText = f.model.text;
			f.model.text = (request) =>
				request.version === 2
					? JSON.stringify(
							scenario === "last_tokens"
								? {
										kind: "post",
										segments: [
											{ kind: "imaginative", text: "A public moment." },
										],
									}
								: { kind: "no_post" },
						)
					: priorText(request);
			if (scenario === "last_tokens") {
				const { worldId, revision, ...config } =
					f.store.lifeConfig("test-world");
				if (!config.usage) throw Error("Missing token budget");
				const { usage } = f.store.publicationExecutionStatus(worldId);
				f.store.setLifeConfig(worldId, revision, {
					...config,
					usage: {
						...config.usage,
						maxInputTokens: usage.inputTokens + 11,
						maxOutputTokens: usage.outputTokens + 7,
					},
				});
			}
			const config = f.store.lifeConfig("test-world");
			const lease = f.store.acquireLifeLease(
				"test-world",
				config.revision,
				"initial-schedule",
				f.clock.now(),
				300,
			);
			f.store.advanceLifeSchedule(lease, f.clock.now(), 100, 0);
			f.store.releaseLifeLease(lease, f.clock.now());
			f.clock.advance(scenario === "last_tokens" ? 100 : 250);
			runtime.start();
			expect(await Promise.race([firstCall.promise, failed.promise])).toBe(
				"publication",
			);
			await Promise.race([
				f.clock.waitingAt(scenario === "last_tokens" ? 1100 : 300),
				failed.promise,
			]);
			const order = f.model.requests
				.slice(baseline)
				.filter(
					(request) =>
						request.lane === "director" || request.lane === "publication",
				)
				.map((request) => request.lane);
			expect(order).toEqual(
				scenario === "last_tokens"
					? ["publication"]
					: [
							"publication",
							"director",
							"publication",
							"director",
							"publication",
						],
			);
			expect(f.store.lifeSnapshot("test-world").revision).toBe(
				scenario === "last_tokens" ? 1 : 3,
			);
			expect(f.store.pendingPublicationRuns("test-world")).toEqual([]);
			expect(f.store.automaticPublicationInput("test-world")).toBeNull();
			expect(
				f.store.publicationExecutionStatus("test-world").schedule?.lease,
			).toBeNull();
			expect(f.clock.pending).toBe(1);
			expect(errors).toEqual([]);
			const { grant } = f.store.mintPublicationViewer("test-world", {
				requestKey: "viewer",
				expectedSettingsRevision: 1,
				recipientId: "friends",
			});
			expect(
				f.store.publicationFeed(
					"test-world",
					{ kind: "viewer", grantId: grant.id },
					{ limit: 10, after: null },
				).items,
			).toHaveLength(scenario === "last_tokens" ? 1 : 0);
		} finally {
			await runtime.close();
			await f.close();
		}
	},
	20000,
);
