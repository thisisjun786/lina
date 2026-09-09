import { afterEach, expect, test } from "bun:test";
import { lifeDigest } from "../../lina-core/src/world/life-json.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { socialIntent } from "../../lina-core/test/life-social-pack-fixture.ts";
import { createLifeRunner } from "../src/life/runner.ts";
import { createLifeRuntime } from "../src/life/runtime.ts";
import { deferred, RuntimeModel } from "./life-runtime-fixture.ts";
import {
	revealIntent,
	revealToSol,
	runtimeStoreFixture,
} from "./life-runtime-store-fixture.ts";

const fixtures: ReturnType<typeof runtimeStoreFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});
function setup(
	quiet = true,
	configure?: Parameters<typeof runtimeStoreFixture>[1],
) {
	const fixture = runtimeStoreFixture(quiet, configure);
	fixtures.push(fixture);
	return fixture;
}
const signal = () => new AbortController().signal;

test("quiet step accepts and reuses one receipt without any model request", async () => {
	const f = setup();
	const first = await f.runner.run("test-world", "quiet-1", 1, signal());
	expect(first.status).toBe("accepted");
	expect(first.outcome?.kind).toBe("quiet");
	expect(f.model.requests).toHaveLength(0);
	const replay = await f.runner.run("test-world", "quiet-1", 1, signal());
	expect(replay.id).toBe(first.id);
	expect(replay.receipt?.eventId).toBe(first.receipt?.eventId);
	expect(f.clock.pending).toBe(0);
});

test("full cast preflight rejects five calls before preparing a native request", async () => {
	const f = setup(false);
	const {
		worldId: _world,
		revision: _revision,
		...config
	} = f.store.lifeConfig("test-world");
	if (!config.limits) throw Error("Fixture needs explicit limits");
	f.store.setLifeConfig("test-world", 1, {
		...config,
		limits: { ...config.limits, maxModelCalls: 5 },
	});
	// Core rejects the known insufficient bound before allocating a step or seed.
	await expect(
		f.runner.run("test-world", "underfunded", 2, signal()),
	).rejects.toThrow(/budget requires 6, configured 5/);
	expect(f.model.prepared).toHaveLength(0);
});

test("activity uses isolated actor routes and never sends actor narration to target", async () => {
	const f = setup(false);
	const result = await f.runner.run("test-world", "activity", 1, signal());
	expect(result.status).toBe("accepted");
	expect(f.model.requests.map((request) => request.lane)).toEqual([
		"director",
		"actor",
		"target",
		"reflection",
		"reflection",
	]);
	for (const request of f.model.requests) {
		expect(request.provider).toBe(
			request.lane === "director" ? "director-route" : "actor-route",
		);
		if (request.agentId !== "lina") {
			expect(request.input).not.toContain("ACTOR_PRIVATE");
			expect(request.input).not.toContain("Private goal");
		}
	}
	await f.runner.run("test-world", "activity", 1, signal());
	expect(f.model.requests).toHaveLength(5);
});

test("foreground cancels a dispatched request, holds unknown usage and drains on close", async () => {
	const f = setup(false),
		entered = deferred<void>(),
		exited = deferred<void>();
	f.model.onComplete = async (_request, abort) => {
		entered.resolve();
		await new Promise<void>((_resolve, reject) =>
			abort.addEventListener(
				"abort",
				() => {
					exited.resolve();
					reject(abort.reason);
				},
				{ once: true },
			),
		);
		throw Error("unreachable");
	};
	const run = f.runner.run("test-world", "interrupted", 1, signal());
	await entered.promise;
	f.foreground.set(true);
	await exited.promise;
	const result = await run;
	expect(result.status).toBe("needs_attention");
	expect(result.models[0]?.status).toBe("unknown");
	expect(
		f.store.lifeStatus("test-world", f.clock.now()).usage.unknownRequests,
	).toBe(1);
	await f.runner.close();
	expect(f.model.closed).toBe(true);
	expect(f.clock.pending).toBe(0);
});

test("malformed actor output is terminal and completed receipts are not rerolled", async () => {
	const f = setup(false);
	f.model.text = (request) =>
		request.lane === "director" ? "An opportunity" : "{bad-json";
	const first = await f.runner.run("test-world", "invalid-output", 1, signal());
	expect(first.status).toBe("failed");
	expect(first.error).toMatch(/invalid_model_output/);
	await f.runner.run("test-world", "invalid-output", 1, signal());
	expect(f.model.requests).toHaveLength(2);
});

test("three recipients cause six calls and raw pending input stays unconsumed", async () => {
	const f = setup(false, revealToSol);
	const original = f.model.text;
	f.model.text = (request) =>
		request.lane === "actor"
			? JSON.stringify(revealIntent())
			: original(request);
	const source = {
		kind: "application" as const,
		sourceId: "untyped-inbox",
		text: "RAW_PENDING_CANARY",
	};
	f.store.admitLifeInput({
		version: 1,
		worldId: "test-world",
		id: "input-1",
		sourceRevision: 1,
		payloadDigest: lifeDigest(source),
		source,
		consumedLifeRevision: null,
	});
	const result = await f.runner.run(
		"test-world",
		"three-recipient",
		1,
		signal(),
	);
	expect(result.status).toBe("accepted");
	expect(result.reflectionAgentIds).toEqual(["lina", "mira", "sol"]);
	expect(f.model.requests).toHaveLength(6);
	for (const request of f.model.requests) {
		expect(request.input).not.toContain("RAW_PENDING_CANARY");
		if (request.agentId !== "lina")
			expect(request.input).not.toContain("ACTOR_PRIVATE");
		if (request.lane === "target")
			expect(request.input).not.toContain("The hidden key is blue");
	}
	expect(f.store.lifeInputs("test-world")[0]?.consumedLifeRevision).toBeNull();
});

test("extension intention finishes without target, social engine or fake reflection", async () => {
	const f = setup(false),
		original = f.model.text;
	f.model.text = (request) =>
		request.lane === "actor"
			? JSON.stringify({
					...socialIntent(),
					primitives: [
						{ kind: "teleport", proposal: "A proposed new capability" },
					],
				})
			: original(request);
	const result = await f.runner.run("test-world", "extension", 1, signal());
	expect(result.status).toBe("accepted");
	expect(result.outcome?.kind).toBe("extension_required");
	expect(result.reflectionAgentIds).toEqual([]);
	expect(result.outcome?.commit.experiences).toEqual([]);
	expect(f.model.requests.map((request) => request.lane)).toEqual([
		"director",
		"actor",
	]);
});

test("runner admits only one global background invocation and renews with its clock", async () => {
	const f = setup(false),
		entered = deferred<void>(),
		released = deferred<void>();
	f.model.onComplete = async (request) => {
		entered.resolve();
		await released.promise;
		return f.model.result(request);
	};
	const run = f.runner.run("test-world", "first", 1, signal());
	await entered.promise;
	await expect(
		f.runner.run("test-world", "second", 1, signal()),
	).rejects.toThrow(/busy/);
	await f.clock.waitingAt(100);
	f.clock.advance(100);
	await f.clock.waitingAt(200);
	expect(f.store.lifeStatus("test-world", 100).schedule?.lease?.expiresAt).toBe(
		400,
	);
	released.resolve();
	expect((await run).status).toBe("accepted");
});

test("configuration change during a native turn keeps usage but cannot accept stale work", async () => {
	const f = setup(false),
		entered = deferred<void>(),
		released = deferred<void>();
	f.model.onComplete = async (request) => {
		entered.resolve();
		await released.promise;
		return f.model.result(request);
	};
	const run = f.runner.run("test-world", "stale-config", 1, signal());
	await entered.promise;
	const {
		worldId: _world,
		revision: _revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", 1, {
		...config,
		run: { mode: "paused" },
	});
	f.runner.cancel("test-world");
	released.resolve();
	const result = await run;
	expect(result.status).not.toBe("accepted");
	expect(result.models[0]?.usage.totalTokens).toBe(18);
	expect(f.store.lifeStatus("test-world", 0).status).toBe("paused");
});

test("accepted steps survive actual SQLite close and reopen without inference", async () => {
	const f = setup();
	const first = await f.runner.run("test-world", "reopen", 1, signal());
	await f.runner.close();
	f.store.close();
	const store = new WorldStore(f.path, () => f.clock.now()),
		model = new RuntimeModel();
	const runner = createLifeRunner({
		...f.options,
		store,
		model,
		owner: "reopened",
	});
	try {
		const result = await runner.run("test-world", "reopen", 1, signal());
		expect(result.status).toBe("accepted");
		expect(result.receipt?.eventId).toBe(first.receipt?.eventId);
		expect(model.requests).toHaveLength(0);
	} finally {
		await runner.close();
		store.close();
	}
});

test("runtime close rejects new manual runs immediately", async () => {
	const f = setup();
	const runtime = createLifeRuntime({
		...f.options,
		worldIds: () => ["test-world"],
		config: (worldId) => f.store.lifeConfig(worldId),
		acquireLease: () => {
			throw Error("Unexpected schedule acquisition");
		},
		onError: () => {
			throw Error("Unexpected scheduler failure");
		},
	});
	const closing = runtime.close();
	await expect(
		runtime.run("test-world", "after-close", 1, signal()),
	).rejects.toThrow(/closed/);
	await closing;
});

test("cleanup retry retains model ownership when the first close fails", async () => {
	const f = setup();
	let attempts = 0;
	f.model.close = async () => {
		if (++attempts === 1) throw Error("Owned cleanup incomplete");
		f.model.closed = true;
	};
	await expect(f.runner.close()).rejects.toThrow(/incomplete/);
	await f.runner.close();
	expect(f.model.closed).toBe(true);
	expect(attempts).toBe(2);
});

test("restart after the non-target reflection reuses all six receipts and the exact recipient list", async () => {
	const f = setup(false, revealToSol),
		abort = new AbortController(),
		original = f.model.text;
	f.model.text = (request) =>
		request.lane === "actor"
			? JSON.stringify(revealIntent())
			: original(request);
	f.model.onComplete = async (request) => {
		if (
			request.request.lane === "reflection" &&
			request.request.agentId === "sol"
		)
			abort.abort(Error("Stopped after last reflection"));
		return f.model.result(request);
	};
	const first = await f.runner.run(
		"test-world",
		"resume-reflections",
		1,
		abort.signal,
	);
	expect(first.status).toBe("needs_attention");
	expect(first.reflectionAgentIds).toEqual(["lina", "mira", "sol"]);
	expect(first.models.every((row) => row.status === "completed")).toBe(true);
	expect(f.model.requests).toHaveLength(6);
	await f.runner.close();
	f.store.close();
	const store = new WorldStore(f.path, () => f.clock.now()),
		model = new RuntimeModel();
	const runner = createLifeRunner({
		...f.options,
		store,
		model,
		owner: "resumed-reflections",
	});
	try {
		const resumed = await runner.run(
			"test-world",
			"resume-reflections",
			1,
			signal(),
		);
		expect(resumed.status).toBe("accepted");
		expect(resumed.reflectionAgentIds).toEqual(first.reflectionAgentIds);
		expect(model.requests).toHaveLength(0);
		expect(resumed.outcome?.commit.knowledgeGrants).toHaveLength(1);
	} finally {
		await runner.close();
		store.close();
	}
});

test("a private third-party consequence causes reflection without granting event witness access", async () => {
	const f = setup(false, (pack) => {
		pack.social.triggers.push({
			id: "private",
			bindings: [],
			conditions: [
				{
					predicateId: "trust",
					first: { kind: "agent", agentId: "lina" },
					second: { kind: "agent", agentId: "mira" },
					operator: "=",
					value: 1,
					window: null,
				},
			],
			effects: [
				{
					predicateId: "trust",
					first: { kind: "agent", agentId: "sol" },
					second: { kind: "agent", agentId: "lina" },
					operator: "+",
					value: 1,
				},
			],
		});
	});
	const result = await f.runner.run(
		"test-world",
		"private-consequence",
		1,
		signal(),
	);
	expect(result.status).toBe("accepted");
	expect(result.reflectionAgentIds).toEqual(["lina", "mira", "sol"]);
	expect(result.outcome?.commit.world.audience).not.toContain("sol");
	const reflection = f.model.requests.find(
		(request) => request.lane === "reflection" && request.agentId === "sol",
	);
	expect(reflection).toBeDefined();
	expect(reflection?.input).not.toContain("ACTOR_PRIVATE");
	expect(reflection?.input).not.toContain("The hidden key is blue");
});

test("paused and missing actor configurations report explicit inactivity without preparing a model", async () => {
	const f = setup();
	const {
		worldId: _world,
		revision: _revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", 1, {
		...config,
		run: { mode: "paused" },
	});
	await expect(
		f.runner.run("test-world", "paused", 2, signal()),
	).rejects.toThrow(/paused/);
	f.store.setLifeConfig("test-world", 2, {
		...config,
		models: { director: config.models?.director ?? null, actor: null },
	});
	await expect(
		f.runner.run("test-world", "missing", 3, signal()),
	).rejects.toThrow(/not_configured.*models.actor/);
	expect(f.model.prepared).toHaveLength(0);
});

test("fresh model settings fence the next lane and final acceptance after a completed call", async () => {
	const f = setup(false),
		entered = deferred<void>(),
		released = deferred<void>();
	f.model.onComplete = async (request) => {
		entered.resolve();
		await released.promise;
		return f.model.result(request);
	};
	const run = f.runner.run("test-world", "settings-change", 1, signal());
	await entered.promise;
	const current = f.options.identity();
	f.options.identity = () => ({ ...current, modelSettingsRevision: 2 });
	released.resolve();
	const result = await run;
	expect(result.status).toBe("stale");
	expect(result.models[0]?.usage.totalTokens).toBe(18);
	expect(f.model.requests).toHaveLength(1);
});

test("release errors propagate unless the store confirms the lease is no longer owned", async () => {
	for (const message of ["Storage write failed", "Stale LIFE lease"]) {
		const f = setup();
		const store = new Proxy(f.store, {
			get(target, key, receiver) {
				if (key === "releaseLifeLease")
					return () => {
						throw Error(message);
					};
				return Reflect.get(target, key, receiver);
			},
		});
		const runner = createLifeRunner({
			...f.options,
			store,
			owner: "release-failure",
		});
		try {
			await expect(
				runner.run("test-world", "release-failure", 1, signal()),
			).rejects.toThrow(message);
		} finally {
			await runner.close();
		}
	}
});

test("runner freezes new steps while preserving legacy idempotent replay", async () => {
	const f = setup();
	const legacy = await f.runner.run("test-world", "legacy", 1, signal());
	await f.runner.close();
	let resolutions = 0;
	let effort: "low" | "high" = "low";
	const runner = createLifeRunner({
		...f.options,
		resolveModels(worldId: string) {
			resolutions++;
			const config = f.store.lifeConfig(worldId);
			const resolve = (lane: "director" | "actor") => {
				const route = config.models?.[lane];
				if (!route) return null;
				const fields = {
					profileId: lane,
					...route,
					reasoning: effort,
					maxOutputTokens: null,
					settingsRevision: 1,
				};
				return { ...fields, routeFingerprint: lifeDigest(fields) };
			};
			return { director: resolve("director"), actor: resolve("actor") };
		},
	});
	try {
		expect(await runner.run("test-world", "legacy", 1, signal())).toEqual(
			legacy,
		);
		expect(resolutions).toBe(0);
		const next = await runner.run("test-world", "frozen", 1, signal());
		expect(next.version).toBe(4);
		expect(next.status).toBe("accepted");
		expect(next.source.resolvedModels?.actor?.reasoning).toBe("low");
		expect(await runner.run("test-world", "frozen", 1, signal())).toEqual(next);
		expect(resolutions).toBe(2);
		effort = "high";
		await expect(
			runner.run("test-world", "frozen", 1, signal()),
		).rejects.toThrow(/idempotency conflict/);
	} finally {
		await runner.close();
	}
});
