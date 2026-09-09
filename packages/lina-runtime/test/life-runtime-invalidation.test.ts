import { expect, test } from "bun:test";
import { join } from "node:path";
import { ModelSettingsStore } from "../src/models/settings.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";

test.each(["identity", "settings"] as const)(
	"%s changes persist stale before abort, retain known usage and admit a fresh step after restart",
	async (kind) => {
		const f = await fleetLifeFixture(),
			released = Promise.withResolvers<void>();
		let pending: Promise<unknown> | undefined;
		try {
			f.setup(false);
			const model = f.models[0];
			if (!model) throw Error("Missing synthetic model");
			const entered = Promise.withResolvers<AbortSignal>();
			model.onComplete = async (prepared, signal) => {
				entered.resolve(signal);
				await released.promise;
				return model.result(prepared);
			};
			pending = f.app.fleet.lifeRuntime.run(
				"test-world",
				"stale-old",
				1,
				new AbortController().signal,
			);
			const signal = await entered.promise;
			const stepId = f.app.fleet.lifeRuntime.status("test-world").activeStepId;
			if (!stepId) throw Error("Missing active step");
			if (kind === "identity")
				f.app.fleet.agents.update("lina", 1, {
					personality: "Changed actual profile",
				});
			else {
				const { revision, ...settings } = f.app.fleet.modelSettings.snapshot();
				f.app.fleet.modelSettings.replace(revision, settings);
			}
			expect(f.app.fleet.lifeRuntime.step("test-world", stepId).status).toBe(
				"stale",
			);
			expect(signal.aborted).toBe(true);
			expect(signal.reason).toMatchObject({ reason: "stale" });
			released.resolve();
			await pending;
			const step = f.app.fleet.lifeRuntime.step("test-world", stepId);
			expect(step.status).toBe("stale");
			expect(step.models[0]?.status).toBe("completed");
			expect(step.models[0]?.usage).toEqual({
				inputTokens: 11,
				outputTokens: 7,
				totalTokens: 18,
			});
			expect(f.app.fleet.lifeRuntime.status("test-world")).toMatchObject({
				status: "ready",
				activeStepId: null,
				usage: {
					inputTokens: 11,
					outputTokens: 7,
					unknownRequests: 0,
					upstreamAttempts: 1,
				},
			});
			await f.restart();
			expect(f.app.fleet.lifeRuntime.step("test-world", stepId)).toEqual(step);
			const fresh = await f.app.fleet.lifeRuntime.run(
				"test-world",
				"stale-new",
				1,
				new AbortController().signal,
			);
			expect(fresh.status).toBe("accepted");
			expect(fresh.source.modelSettingsRevision).toBe(
				kind === "settings" ? 2 : 1,
			);
			expect(f.providerCalls).toBe(0);
		} finally {
			released.resolve();
			await pending?.catch(() => undefined);
			await f.close();
		}
	},
);

test.each(["identity", "settings"] as const)(
	"automatic %s invalidation replaces the scheduled key and admits the next ordinary delayed wake",
	async (kind) => {
		const f = await fleetLifeFixture(),
			released = Promise.withResolvers<void>();
		try {
			f.setup(false, true);
			const model = f.models[0];
			if (!model) throw Error("Missing model");
			const entered = Promise.withResolvers<void>();
			model.onComplete = async (prepared) => {
				entered.resolve();
				await released.promise;
				return model.result(prepared);
			};
			await f.clock.waitingAt(100);
			f.clock.advance(101);
			await entered.promise;
			const before = f.app.fleet.lifeRuntime.status("test-world");
			if (!before.activeStepId || !before.schedule)
				throw Error("Missing scheduled step");
			const old = f.app.fleet.lifeRuntime.step(
				"test-world",
				before.activeStepId,
			);
			if (kind === "identity")
				f.app.fleet.agents.update("lina", 1, {
					personality: "Updated automatic profile",
				});
			else {
				const { revision, ...settings } = f.app.fleet.modelSettings.snapshot();
				f.app.fleet.modelSettings.replace(revision, settings);
			}
			expect(
				f.app.fleet.lifeRuntime.status("test-world").schedule,
			).toMatchObject({
				generation: before.schedule.generation + 1,
				nextDue: null,
				lease: null,
			});
			released.resolve();
			await f.clock.waitingAt(201);
			expect(f.app.fleet.lifeRuntime.step("test-world", old.id)).toMatchObject({
				status: "stale",
				models: [{ status: "completed", upstreamAttempts: 1 }],
			});
			f.clock.advance(202);
			await f.clock.waitingAt(301);
			const status = f.app.fleet.lifeRuntime.status("test-world");
			if (!status.schedule?.lastStepId) throw Error("Missing accepted step");
			const next = f.app.fleet.lifeRuntime.step(
				"test-world",
				status.schedule.lastStepId,
			);
			expect(next.status).toBe("accepted");
			expect(next.idempotencyKey).not.toBe(old.idempotencyKey);
			expect(next.source.modelSettingsRevision).toBe(
				kind === "settings" ? 2 : 1,
			);
			expect(status).toMatchObject({
				status: "ready",
				activeStepId: null,
				schedulerError: null,
				schedule: { lastSkippedIntervals: 0 },
				usage: {
					inputTokens: 66,
					outputTokens: 42,
					upstreamAttempts: 6,
					unknownRequests: 0,
				},
			});
			expect(model.requests).toHaveLength(6);
			expect(f.providerCalls).toBe(0);
		} finally {
			released.resolve();
			await f.close();
		}
	},
);

test("an unrelated profile change preserves the running world's lease and model call", async () => {
	const f = await fleetLifeFixture(),
		released = Promise.withResolvers<void>();
	let pending: ReturnType<typeof f.app.fleet.lifeRuntime.run> | undefined;
	try {
		f.setup(false);
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const entered = Promise.withResolvers<AbortSignal>();
		model.onComplete = async (prepared, signal) => {
			entered.resolve(signal);
			await released.promise;
			return model.result(prepared);
		};
		pending = f.app.fleet.lifeRuntime.run(
			"test-world",
			"unrelated-profile",
			1,
			new AbortController().signal,
		);
		const signal = await entered.promise;
		const before = f.app.fleet.lifeRuntime.status("test-world");
		const seed = f.app.fleet.agents.get("lina");
		if (!seed) throw Error("Missing profile");
		const { revision: _revision, ...input } = seed;
		f.app.fleet.agents.create({ ...input, id: "outside-world" });
		expect(signal.aborted).toBe(false);
		expect(f.app.fleet.lifeRuntime.status("test-world").schedule).toEqual(
			before.schedule,
		);
		released.resolve();
		expect((await pending).status).toBe("accepted");
		expect(model.requests).toHaveLength(5);
		expect(f.providerCalls).toBe(0);
	} finally {
		released.resolve();
		await pending?.catch(() => undefined);
		await f.close();
	}
});

test.each(["identity", "settings"] as const)(
	"%s invalidation retains an uncertain outbound receipt and continues blocking a fresh step after restart",
	async (kind) => {
		const f = await fleetLifeFixture(),
			released = Promise.withResolvers<void>();
		let pending: Promise<unknown> | undefined;
		try {
			f.setup(false);
			const model = f.models[0];
			if (!model) throw Error("Missing model");
			const entered = Promise.withResolvers<void>();
			model.onComplete = async () => {
				entered.resolve();
				await released.promise;
				throw Error("Synthetic unknown response");
			};
			pending = f.app.fleet.lifeRuntime.run(
				"test-world",
				"unknown-old",
				1,
				new AbortController().signal,
			);
			await entered.promise;
			const id = f.app.fleet.lifeRuntime.status("test-world").activeStepId;
			if (!id) throw Error("Missing step");
			if (kind === "identity")
				f.app.fleet.agents.update("lina", 1, {
					personality: "Changed actual profile",
				});
			else {
				const { revision, ...settings } = f.app.fleet.modelSettings.snapshot();
				f.app.fleet.modelSettings.replace(revision, settings);
			}
			released.resolve();
			await pending;
			expect(f.app.fleet.lifeRuntime.step("test-world", id).status).toBe(
				"stale",
			);
			expect(
				f.app.fleet.lifeRuntime.step("test-world", id).models[0]?.status,
			).toBe("unknown");
			await f.restart();
			expect(f.app.fleet.lifeRuntime.status("test-world")).toMatchObject({
				status: "needs_attention",
				activeStepId: null,
				usage: { unknownRequests: 1 },
			});
			await expect(
				f.app.fleet.lifeRuntime.run(
					"test-world",
					"unknown-new",
					1,
					new AbortController().signal,
				),
			).rejects.toThrow(/needs_attention/);
			expect(f.models.at(-1)?.requests).toHaveLength(0);
		} finally {
			released.resolve();
			await pending?.catch(() => undefined);
			await f.close();
		}
	},
);

test("startup invalidates an older known-accounted pending step when settings changed while stopped", async () => {
	const f = await fleetLifeFixture(),
		released = Promise.withResolvers<void>();
	let pending: Promise<unknown> | undefined;
	try {
		f.setup(false);
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		const entered = Promise.withResolvers<void>();
		model.onComplete = async (prepared) => {
			entered.resolve();
			await released.promise;
			return model.result(prepared);
		};
		pending = f.app.fleet.lifeRuntime.run(
			"test-world",
			"restart-old",
			1,
			new AbortController().signal,
		);
		await entered.promise;
		const id = f.app.fleet.lifeRuntime.status("test-world").activeStepId;
		if (!id) throw Error("Missing step");
		f.app.fleet.lifeForeground.set("foreground", true);
		released.resolve();
		await pending;
		expect(f.app.fleet.lifeRuntime.step("test-world", id).status).toBe(
			"needs_attention",
		);
		await f.app.stop();
		const settings = new ModelSettingsStore(
			join(f.root, "state/models.sqlite"),
		);
		try {
			const { revision, ...input } = settings.snapshot();
			settings.replace(revision, input);
		} finally {
			settings.close();
		}
		await f.restart();
		expect(f.app.fleet.lifeRuntime.step("test-world", id).status).toBe("stale");
		expect(f.app.fleet.lifeRuntime.status("test-world").status).toBe("ready");
		expect(
			(
				await f.app.fleet.lifeRuntime.run(
					"test-world",
					"restart-new",
					1,
					new AbortController().signal,
				)
			).status,
		).toBe("accepted");
	} finally {
		released.resolve();
		await pending?.catch(() => undefined);
		await f.close();
	}
});
