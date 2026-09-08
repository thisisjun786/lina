import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { lifeConfigReadiness } from "../src/life/config.ts";
import { fleetLifeFixture } from "./life-runtime-fleet-fixture.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("fresh fleet remains unconfigured without creating a world database or native transport", async () => {
	const f = await fleetLifeFixture();
	try {
		expect(existsSync(join(f.root, "state/life/world.sqlite"))).toBe(false);
		expect(f.models).toHaveLength(0);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test("manual native composition pins actual profiles, routes and settings with owner-only detail", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup(false);
		const runtime = f.app.fleet.lifeRuntime;
		const step = await runtime.run(
			"test-world",
			"native-composed",
			1,
			new AbortController().signal,
		);
		expect(step.status).toBe("accepted");
		expect(step.models.length).toBeGreaterThan(1);
		expect(step.source.profiles).toEqual(
			step.source.pack.life.participants.map((id) => {
				const profile = f.app.fleet.agents.get(id);
				if (!profile) throw Error("Missing actual profile");
				return profile;
			}),
		);
		expect(step.source.modelSettingsRevision).toBe(1);
		for (const { prepared } of step.models) {
			const request = prepared.request;
			expect(f.selections[0]?.selection(request)).toMatchObject({
				settingsRevision: 1,
				selected: {
					provider: "opencodex",
					model: request.lane === "director" ? "route/director" : "route/actor",
				},
			});
			expect(() =>
				f.selections[0]?.selection({ ...request, model: "foreign/model" }),
			).toThrow();
			expect(() =>
				f.selections[0]?.selection({ ...request, modelSettingsRevision: 0 }),
			).toThrow();
		}
		expect(JSON.stringify(runtime.step("test-world", step.id))).toContain(
			"PRIVATE_FLEET_DIRECTOR",
		);
		expect(JSON.stringify(f.app.fleet.summary())).not.toContain(
			"PRIVATE_FLEET_DIRECTOR",
		);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test.each(["config", "identity", "model", "foreground"] as const)(
	"%s change cancels an in-flight native call and fences a late result",
	async (kind) => {
		const f = await fleetLifeFixture();
		const returned = Promise.withResolvers<void>();
		try {
			const { config } = f.setup(false);
			const model = f.models[0];
			if (!model) throw Error("Missing model");
			const dispatched = Promise.withResolvers<AbortSignal>();
			model.onComplete = async (prepared, signal) => {
				dispatched.resolve(signal);
				await returned.promise;
				return model.result(prepared);
			};
			const runtime = f.app.fleet.lifeRuntime;
			const pending = runtime
				.run("test-world", `fence-${kind}`, 1, new AbortController().signal)
				.catch(() => null);
			const signal = await dispatched.promise;
			if (kind === "config")
				f.app.fleet.life.setConfig("test-world", 1, {
					...config,
					run: { mode: "paused" },
				});
			if (kind === "identity")
				f.app.fleet.agents.update("lina", 1, {
					personality: "A changed actual profile",
				});
			if (kind === "model") {
				const { revision, ...settings } = f.app.fleet.modelSettings.snapshot();
				f.app.fleet.modelSettings.replace(revision, settings);
			}
			if (kind === "foreground") {
				const chat = await f.app.fleet.app("lina");
				chat.runtime.submit("foreground-priority", "Hello");
			}
			expect(signal.aborted).toBe(true);
			returned.resolve();
			const result = await pending;
			expect(result?.status).not.toBe("accepted");
			expect(model.requests).toHaveLength(1);
		} finally {
			returned.resolve();
			await f.close();
		}
	},
);

test("foreground completion wakes the automatic scheduler without a provider call before due", async () => {
	const f = await fleetLifeFixture();
	try {
		f.setup(true, true);
		await f.clock.waitingAt(100);
		const chat = await f.app.fleet.app("lina");
		chat.runtime.submit("chat-priority", "Hello");
		expect(f.app.fleet.lifeForeground.active()).toBe(true);
		f.clock.advance(100);
		await expect(
			f.app.fleet.lifeRuntime.run(
				"test-world",
				"busy",
				1,
				new AbortController().signal,
			),
		).rejects.toThrow("foreground");
		await chat.runtime.cancel("chat-priority");
		await f.clock.waitingAt(200);
		expect(
			f.app.fleet.lifeRuntime.status("test-world").schedule?.lastStepId,
		).not.toBeNull();
		expect(f.models[0]?.requests).toHaveLength(0);
		expect(chat.runtime.native).toBeInstanceOf(ControlledSession);
	} finally {
		await f.close();
	}
});

test("concurrent fleet close retains store and installation ownership until native teardown resolves", async () => {
	const f = await fleetLifeFixture();
	const stopped = Promise.withResolvers<void>(),
		closing = Promise.withResolvers<void>();
	try {
		f.setup();
		const store = f.app.fleet.life.store;
		const model = f.models[0];
		if (!model) throw Error("Missing model");
		model.close = async () => {
			closing.resolve();
			await stopped.promise;
			expect(store.lifeConfig("test-world").revision).toBe(1);
			model.closed = true;
		};
		const first = f.app.fleet.close();
		await closing.promise;
		let secondDone = false;
		const second = f.app.fleet.close().then(() => {
			secondDone = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(secondDone).toBe(false);
		expect(() => acquireInstallationLock(join(f.root, "state"))).toThrow();
		stopped.resolve();
		await Promise.all([first, second]);
		expect(model.closed).toBe(true);
		expect(() => store.lifeConfig("test-world")).toThrow();
	} finally {
		stopped.resolve();
		await f.close();
	}
});

test("explicit text config is ready without media; startup discovers automatic worlds and waits until due", async () => {
	const f = await fleetLifeFixture();
	try {
		const { config } = f.setup(true, true);
		expect(lifeConfigReadiness(config)).toMatchObject({
			status: "configured",
			automaticReady: true,
			missing: [],
		});
		await f.clock.waitingAt(100);
		expect(f.app.fleet.lifeRuntime.status("test-world").schedule?.nextDue).toBe(
			100,
		);
		await f.restart();
		await f.clock.waitingAt(100);
		expect(f.models.every((model) => model.requests.length === 0)).toBe(true);
		f.clock.advance(100);
		await f.clock.waitingAt(200);
		expect(
			f.app.fleet.lifeRuntime.status("test-world").schedule?.lastStepId,
		).not.toBeNull();
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});
