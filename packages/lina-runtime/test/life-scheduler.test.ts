import { afterEach, expect, test } from "bun:test";
import type {
	LifeLease,
	LifeRunStatus,
	LifeSchedule,
	LifeStep,
} from "../../lina-core/src/world/autonomy-types.ts";
import { pureStep } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { createLifeScheduler } from "../src/life/scheduler.ts";
import { ModelRequestError } from "../src/models/errors.ts";
import {
	deferred,
	RuntimeClock,
	RuntimeForeground,
	RuntimeModel,
	runtimeConfig,
} from "./life-runtime-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

const schedulers: ReturnType<typeof createLifeScheduler>[] = [];
test("unconfigured model routing waits for a configuration wake instead of interval retries", async () => {
	const f = setup();
	const failed = deferred<void>();
	let attempts = 0;
	const scheduler = createLifeScheduler({
		...f.options,
		runner: {
			...f.options.runner,
			async run() {
				attempts++;
				throw new ModelRequestError("Choose shared tiers", "not_configured");
			},
		},
		onError() {
			failed.resolve();
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await f.clock.waitingAt(100);
	f.clock.advance(100);
	await failed.promise;
	expect(attempts).toBe(1);
	expect(f.clock.pending).toBe(0);
});
const realStores: ReturnType<typeof runtimeStoreFixture>[] = [];
afterEach(async () => {
	for (const scheduler of schedulers.splice(0)) await scheduler.close();
	for (const fixture of realStores.splice(0)) await fixture.close();
});
function setup(catchUp = 0, nextDue: number | null = null) {
	const clock = new RuntimeClock(),
		foreground = new RuntimeForeground(),
		config = runtimeConfig();
	config.run = { mode: "automatic" };
	if (!config.clock) throw Error("Fixture needs explicit clock configuration");
	config.clock.maxCatchUpSteps = catchUp;
	const schedule: LifeSchedule = {
		worldId: "test-world",
		generation: 1,
		configRevision: 1,
		lease: null,
		leaseSequence: 0,
		nextDue,
		lastStepId: null,
		lastClock: 0,
		lastSkippedIntervals: 0,
	};
	const calls: string[] = [],
		skips: number[] = [],
		errors: unknown[] = [];
	let pending: LifeStep | null = null;
	let last: LifeStep | null = null;
	let statusOverride: LifeRunStatus["status"] | null = null;
	let advanced = deferred<void>();
	const store = {
		lifeStatus(): LifeRunStatus {
			return {
				worldId: "test-world",
				status: statusOverride ?? (pending ? "needs_attention" : "ready"),
				missing: [],
				schedule: structuredClone(schedule),
				activeStepId: pending?.id ?? null,
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					reservedInputTokens: 0,
					reservedOutputTokens: 0,
					unknownRequests: 0,
					upstreamAttempts: 0,
					monetaryCost: "unknown",
				},
			};
		},
		lifeStep() {
			const step = pending ?? last;
			if (!step) throw Error("Missing fixture step");
			return step;
		},
		releaseLifeLease(lease: LifeLease) {
			if (schedule.lease?.token === lease.token) schedule.lease = null;
		},
		advanceLifeSchedule(
			lease: LifeLease,
			now: number,
			due: number,
			skipped: number,
		) {
			if (schedule.lease?.token !== lease.token || now >= lease.expiresAt)
				throw Error("Lost lease");
			schedule.nextDue = due;
			schedule.lastClock = now;
			schedule.lastSkippedIntervals = skipped;
			skips.push(skipped);
			advanced.resolve();
			advanced = deferred<void>();
			return structuredClone(schedule);
		},
	};
	const acquireLease = (
		worldId: string,
		revision: number,
		owner: string,
		now: number,
		leaseMs: number,
	): LifeLease => {
		if (
			revision !== config.revision ||
			(schedule.lease && schedule.lease.expiresAt > now)
		)
			throw Error("Lease busy");
		const lease = {
			worldId,
			owner,
			generation: schedule.generation,
			token: ++schedule.leaseSequence,
			expiresAt: now + leaseMs,
		};
		schedule.lease = lease;
		return lease;
	};
	const runner = {
		async run(_world: string, key: string): Promise<LifeStep> {
			calls.push(key);
			pending = null;
			last = { ...pureStep(), idempotencyKey: key, status: "accepted" };
			schedule.lastStepId = last.id;
			return last;
		},
		cancel() {},
	};
	const scheduler = createLifeScheduler({
		store,
		runner,
		config: () => config,
		acquireLease,
		clock,
		foreground,
		worldIds: () => ["test-world"],
		owner: "scheduler-test",
		onError: (_world, error) => errors.push(error),
	});
	schedulers.push(scheduler);
	return {
		clock,
		foreground,
		config,
		schedule,
		calls,
		skips,
		errors,
		setPending(step: LifeStep) {
			pending = step;
		},
		setStatus(status: LifeRunStatus["status"]) {
			statusOverride = status;
		},
		scheduler,
		options: {
			store,
			runner,
			config: () => config,
			acquireLease,
			clock,
			foreground,
			worldIds: () => ["test-world"],
			onError: (_world: string, error: unknown) => errors.push(error),
		},
		async nextAdvance() {
			await advanced.promise;
		},
	};
}

test("scheduler needs explicit automatic mode and initializes a durable nextDue", async () => {
	const f = setup();
	f.scheduler.start();
	await f.clock.waitingAt(100);
	expect(f.schedule.nextDue).toBe(100);
	expect(f.calls).toHaveLength(0);
	f.clock.advance(100);
	await f.clock.waitingAt(200);
	expect(f.calls).toHaveLength(1);
	expect(f.schedule.nextDue).toBe(200);
	expect(f.schedule.lease).toBeNull();
	expect(f.errors).toEqual([]);
});

test("publication participates in the same scheduler even with manual simulation and close drains its active visit", async () => {
	const f = setup();
	f.config.run = { mode: "manual" };
	const entered = deferred<void>(),
		released = deferred<void>();
	const calls: string[] = [];
	const scheduler = createLifeScheduler({
		...f.options,
		async visitPublication(worldId, signal) {
			calls.push(worldId);
			signal.addEventListener("abort", () => released.resolve(), {
				once: true,
			});
			entered.resolve();
			await released.promise;
			return null;
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await entered.promise;
	await scheduler.close();
	expect(calls).toEqual(["test-world"]);
	expect(f.calls).toEqual([]);
	expect(f.clock.pending).toBe(0);
});

test("publication-only catalog worlds never require autonomous status or invent a simulation", async () => {
	const f = setup();
	const visited = deferred<void>();
	const calls: string[] = [];
	const scheduler = createLifeScheduler({
		...f.options,
		worldIds: () => [],
		publicationWorldIds: () => ["legacy", "legacy"],
		store: {
			...f.options.store,
			lifeStatus() {
				throw Error("Legacy world has no autonomous pack");
			},
		},
		async visitPublication(worldId) {
			calls.push(worldId);
			visited.resolve();
			return null;
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await visited.promise;
	await scheduler.close();
	expect(calls).toEqual(["legacy"]);
	expect(f.calls).toEqual([]);
	expect(f.errors).toEqual([]);
});

test("image-only worlds share the clock and wake for the next avatar slot without simulation", async () => {
	const f = setup();
	const calls: number[] = [];
	const scheduler = createLifeScheduler({
		...f.options,
		worldIds: () => [],
		imageWorldIds: () => ["image-only", "image-only"],
		async visitImages(worldId) {
			expect(worldId).toBe("image-only");
			calls.push(f.clock.now());
			return f.clock.now() + 75;
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await f.clock.waitingAt(75);
	f.clock.advance(75);
	await f.clock.waitingAt(150);
	expect(calls).toEqual([0, 75]);
	expect(f.calls).toEqual([]);
	expect(f.errors).toEqual([]);
});

test("images see publication results before simulation and after each accepted catch-up step", async () => {
	const f = setup(2, 100);
	f.clock.advance(250);
	const order: string[] = [];
	const run = f.options.runner.run;
	const scheduler = createLifeScheduler({
		...f.options,
		runner: {
			...f.options.runner,
			async run(...args) {
				order.push("step");
				return run(args[0], args[1]);
			},
		},
		async visitPublication() {
			order.push("post");
			return null;
		},
		async visitImages() {
			order.push("image");
			return null;
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await f.clock.waitingAt(300);
	expect(order).toEqual([
		"post",
		"image",
		"step",
		"post",
		"image",
		"step",
		"post",
		"image",
	]);
	expect(f.errors).toEqual([]);
});

test("foreground defers image visits and close aborts and drains an active image visit", async () => {
	const f = setup();
	f.foreground.set(true);
	const entered = deferred<void>();
	let visits = 0;
	let drained = false;
	const scheduler = createLifeScheduler({
		...f.options,
		worldIds: () => [],
		imageWorldIds: () => ["image-only"],
		async visitImages(_worldId, signal) {
			visits++;
			entered.resolve();
			await new Promise<void>((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
			drained = true;
			return null;
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	expect(visits).toBe(0);
	f.foreground.set(false);
	await entered.promise;
	await scheduler.close();
	expect(visits).toBe(1);
	expect(drained).toBe(true);
	expect(f.clock.pending).toBe(0);
});

test("an armed timer waking one millisecond late executes every interval with zero catch-up", async () => {
	const f = setup();
	f.scheduler.start();
	await f.clock.waitingAt(100);
	for (const [index, time] of [101, 201, 301].entries()) {
		f.clock.advance(time);
		await f.clock.waitingAt((index + 2) * 100);
		expect(f.calls).toHaveLength(index + 1);
		expect(f.schedule.lastSkippedIntervals).toBe(0);
	}
	expect(new Set(f.calls).size).toBe(3);
	expect(f.errors).toEqual([]);
});

test("a restarted timer has no armed occurrence and obeys zero catch-up even one millisecond late", async () => {
	const f = setup();
	f.scheduler.start();
	await f.clock.waitingAt(100);
	await f.scheduler.close();
	f.clock.advance(101);
	const restarted = createLifeScheduler(f.options);
	schedulers.push(restarted);
	restarted.start();
	await f.clock.waitingAt(200);
	expect(f.calls).toHaveLength(0);
	expect(f.schedule.lastSkippedIntervals).toBe(1);
	f.clock.advance(201);
	await f.clock.waitingAt(300);
	expect(f.calls).toHaveLength(1);
	expect(f.schedule.lastSkippedIntervals).toBe(0);
});

test("zero catch-up skips missed periods without creating a model step", async () => {
	const f = setup(0, 100);
	f.clock.advance(350);
	f.scheduler.start();
	await f.clock.waitingAt(400);
	expect(f.calls).toHaveLength(0);
	expect(f.schedule.nextDue).toBe(400);
	expect(f.schedule.lastSkippedIntervals).toBe(3);
});

test("positive catch-up is bounded and preserves skipped interval evidence", async () => {
	const f = setup(2, 100);
	f.clock.advance(550);
	f.scheduler.start();
	await f.clock.waitingAt(600);
	expect(f.calls).toHaveLength(2);
	expect(new Set(f.calls).size).toBe(2);
	expect(f.skips).toContain(3);
	expect(f.schedule.nextDue).toBe(600);
	expect(f.schedule.lastSkippedIntervals).toBe(3);
});

test("foreground and manual mode suppress automation; close drains clock waits", async () => {
	const f = setup();
	f.config.run = { mode: "manual" };
	f.scheduler.start();
	expect(f.calls).toHaveLength(0);
	f.config.run = { mode: "automatic" };
	f.scheduler.wake();
	await f.clock.waitingAt(100);
	f.foreground.set(true);
	f.clock.advance(100);
	f.foreground.set(false);
	await f.clock.waitingAt(200);
	expect(f.calls).toHaveLength(1);
	await f.scheduler.close();
	expect(f.clock.pending).toBe(0);
});

test("two schedulers observe the owned lease and cannot dispatch the same due slot concurrently", async () => {
	const f = setup(0, 100),
		entered = deferred<void>(),
		released = deferred<void>();
	f.clock.advance(100);
	f.options.runner.run = async (world, key) => {
		const lease = f.options.acquireLease(
			world,
			1,
			"active-runner",
			f.clock.now(),
			300,
		);
		f.calls.push(key);
		entered.resolve();
		await released.promise;
		f.options.store.releaseLifeLease(lease);
		return { ...pureStep(), status: "accepted" };
	};
	f.scheduler.start();
	await entered.promise;
	const second = createLifeScheduler({
		...f.options,
		owner: "second-scheduler",
	});
	schedulers.push(second);
	second.start();
	await f.clock.waitingAt(400);
	expect(f.calls).toHaveLength(1);
	released.resolve();
	await f.clock.waitingAt(200);
	second.wake();
	expect(f.schedule.leaseSequence).toBe(2);
	expect(f.schedule.lease).toBeNull();
	expect(f.errors).toEqual([]);
});

test("startup resumes the saved partial step key even when attention is reported", async () => {
	const f = setup(0, 100);
	f.setPending({
		...pureStep(),
		idempotencyKey: "saved-partial-step",
		status: "needs_attention",
		error: "model_unknown",
	});
	f.scheduler.start();
	await f.scheduler.close();
	expect(f.calls).toEqual(["saved-partial-step"]);
});

test("known exhausted usage wakes after its configured rolling window", async () => {
	const f = setup(0, 100);
	f.setStatus("budget_exhausted");
	f.scheduler.start();
	await f.clock.waitingAt(1000);
	expect(f.calls).toHaveLength(0);
	await f.scheduler.close();
	expect(f.clock.pending).toBe(0);
});

test("a real world at LIFE revision zero with zero tokens keeps its configured budget wake", async () => {
	const f = runtimeStoreFixture();
	realStores.push(f);
	const { worldId, revision, ...config } = f.store.lifeConfig("test-world");
	if (!config.usage) throw Error("Missing explicit budget");
	f.store.setLifeConfig(worldId, revision, {
		...config,
		run: { mode: "automatic" },
		usage: { ...config.usage, maxInputTokens: 0, maxOutputTokens: 0 },
	});
	const errors: unknown[] = [];
	const scheduler = createLifeScheduler({
		...f.options,
		runner: f.runner,
		worldIds: () => [worldId],
		config: (world) => f.store.lifeConfig(world),
		acquireLease: (...args) => f.store.acquireLifeLease(...args),
		onError: (_world, error) => errors.push(error),
		visitPublication: async () => null,
	});
	schedulers.push(scheduler);
	scheduler.start();
	await f.clock.waitingAt(1000);
	expect(f.store.lifeSnapshot(worldId).revision).toBe(0);
	expect(f.model.requests).toEqual([]);
	expect(f.clock.pending).toBe(1);
	expect(errors).toEqual([]);
});

test("restart repairs accepted-before-schedule-advance without counting the accepted period as skipped", async () => {
	const f = setup(0, 100),
		advance = f.options.store.advanceLifeSchedule;
	let fail = true;
	f.options.store.advanceLifeSchedule = (...args) => {
		if (fail) {
			fail = false;
			throw Error("Stopped before schedule write");
		}
		return advance(...args);
	};
	f.clock.advance(100);
	f.scheduler.start();
	await f.clock.waitingAt(200);
	expect(f.calls).toHaveLength(1);
	expect(f.schedule.nextDue).toBe(100);
	await f.scheduler.close();
	f.clock.advance(150);
	const resumed = createLifeScheduler({
		...f.options,
		owner: "resumed-schedule",
	});
	schedulers.push(resumed);
	resumed.start();
	await f.clock.waitingAt(200);
	expect(f.calls).toHaveLength(1);
	expect(f.schedule.lastSkippedIntervals).toBe(0);
});

test("real SQLite schedule skips missed time and two runners produce one accepted due step", async () => {
	const f = runtimeStoreFixture();
	realStores.push(f);
	const {
		worldId: _world,
		revision: _revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", 1, {
		...config,
		run: { mode: "automatic" },
	});
	const errors: unknown[] = [];
	const advanced = deferred<void>();
	const observedStore = {
		lifeStatus: f.store.lifeStatus,
		lifeStep: f.store.lifeStep,
		releaseLifeLease: f.store.releaseLifeLease,
		advanceLifeSchedule: (
			...args: Parameters<typeof f.store.advanceLifeSchedule>
		) => {
			const schedule = f.store.advanceLifeSchedule(...args);
			if (schedule.nextDue === 500) advanced.resolve();
			return schedule;
		},
	};
	const options = {
		...f.options,
		store: observedStore,
		runner: f.runner,
		worldIds: () => ["test-world"],
		config: (worldId: string) => f.store.lifeConfig(worldId),
		acquireLease: f.store.acquireLifeLease,
		onError: (_world: string, error: unknown) => errors.push(error),
	};
	const first = createLifeScheduler(options);
	schedulers.push(first);
	first.start();
	await f.clock.waitingAt(100);
	f.clock.advance(350);
	await f.clock.waitingAt(400);
	expect(
		f.store.lifeStatus("test-world", 350).schedule?.lastSkippedIntervals,
	).toBe(3);
	expect(f.store.lifeSnapshot("test-world").revision).toBe(0);
	const secondModel = new RuntimeModel(),
		secondRunner = createLifeRunner({
			...f.options,
			model: secondModel,
			owner: "second-runtime",
		});
	const second = createLifeScheduler({
		...options,
		runner: secondRunner,
		owner: "second-scheduler",
	});
	schedulers.push(second);
	try {
		second.start();
		f.clock.advance(400);
		await advanced.promise;
		expect(f.store.lifeSnapshot("test-world").revision).toBe(1);
		expect(f.store.lifeStatus("test-world", 400).schedule?.nextDue).toBe(500);
		expect(f.model.requests.length + secondModel.requests.length).toBe(0);
		// Both runtimes may race between read and acquire; SQLite rejects the losing owner.
		expect(errors.length).toBeLessThanOrEqual(1);
		expect(
			errors.every(
				(error) =>
					error instanceof Error &&
					error.message === "LIFE world lease is busy",
			),
		).toBe(true);
	} finally {
		await second.close();
		await secondRunner.close();
	}
});

test("another world's timer does not retry an unconfigured model lane", async () => {
	const f = setup();
	let attempts = 0;
	f.setPending(pureStep());
	const scheduler = createLifeScheduler({
		...f.options,
		imageWorldIds: () => ["other"],
		visitImages: async (world) =>
			world === "other" ? (f.clock.now() < 200 ? 200 : 300) : null,
		runner: {
			...f.options.runner,
			async run() {
				attempts++;
				throw new ModelRequestError("Choose shared tiers", "not_configured");
			},
		},
	});
	schedulers.push(scheduler);
	scheduler.start();
	await f.clock.waitingAt(200);
	expect(attempts).toBe(1);
	f.clock.advance(200);
	await f.clock.waitingAt(300);
	expect(attempts).toBe(1);
});
