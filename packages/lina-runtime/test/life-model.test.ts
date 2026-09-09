import { expect, test } from "bun:test";
import { parseLifeConfigInput } from "../../lina-core/src/world/authoring-validation.ts";
import { parsePreparedLifeModel } from "../../lina-core/src/world/autonomy-record-validation.ts";
import { pureStep } from "../../lina-core/test/life-autonomy-pure-fixture.ts";
import {
	buildLifeRequest,
	invokeLifeModel,
	lifeLaneId,
	requiredLifeModelCalls,
} from "../src/life/actor.ts";
import {
	deferred,
	invocationFixture,
	runtimeConfig,
} from "./life-runtime-fixture.ts";
import { runtimeStoreFixture } from "./life-runtime-store-fixture.ts";

test("the full cast needs six admitted calls with only director and actor routes", () => {
	const { worldId: _world, revision: _revision, ...input } = runtimeConfig();
	const config = parseLifeConfigInput(input);
	const step = pureStep();
	step.source.config = { ...config, worldId: step.worldId, revision: 1 };
	expect(requiredLifeModelCalls(step)).toBe(6);
	const usage = {
		inputTokens: 0,
		outputTokens: 0,
		reservedInputTokens: 0,
		reservedOutputTokens: 0,
		unknownRequests: 0,
		upstreamAttempts: 0,
		monetaryCost: "unknown" as const,
	};
	for (const lane of ["director", "actor", "target", "reflection"] as const) {
		const request = buildLifeRequest(step, lane, "lina", usage, {
			systemPrompt: "trusted",
			input: "{}",
		});
		expect(request.provider).toBe(
			lane === "director" ? "director-route" : "actor-route",
		);
		expect(request.modelSettingsRevision).toBe(1);
		expect(request.limits.maxInputTokens).toBe(16666);
		expect(request.limits.maxOutputTokens).toBe(8333);
		expect(
			buildLifeRequest(step, lane, "lina", usage, {
				systemPrompt: "trusted",
				input: "{}",
			}).id,
		).toBe(request.id);
	}
	expect(() =>
		parseLifeConfigInput({
			...input,
			models: { ...input.models, reflection: input.models?.actor },
		}),
	).toThrow();
});

const prompt = () => ({ systemPrompt: "trusted", input: "{}" });
test("native preparation precedes reservation and dispatch; completed result is reused", async () => {
	const f = invocationFixture();
	f.model.onComplete = async (request) => {
		expect(f.trace).toEqual(["reserve", "dispatch"]);
		return f.model.result(request);
	};
	const first = await invokeLifeModel(f.context, "director", "lina", prompt);
	const second = await invokeLifeModel(f.context, "director", "lina", () => {
		throw Error("Completed prompt must not be rebuilt");
	});
	expect(second).toEqual(first);
	expect(f.model.requests).toHaveLength(1);
	expect(f.trace).toEqual(["reserve", "dispatch", "finish"]);
	expect(f.clock.pending).toBe(0);
});

test("restart reconciles a completed native journal without another inference", async () => {
	const f = invocationFixture();
	const request = buildLifeRequest(
		f.step,
		"actor",
		"lina",
		f.context.store.lifeStatus(f.step.worldId, 0).usage,
		prompt(),
	);
	const prepared = await f.model.prepare(request, f.controller.signal);
	f.context.store.prepareLifeModel(f.step.lease, f.step.id, prepared, 0);
	f.context.store.dispatchLifeModel(f.step.lease, f.step.id, request.id, 0);
	f.model.journal.set(request.id, {
		status: "completed",
		result: f.model.result(prepared),
	});
	const result = await invokeLifeModel(f.context, "actor", "lina", prompt);
	expect(result.requestId).toBe(request.id);
	expect(f.model.requests).toHaveLength(0);
	expect(f.step.models[0]?.status).toBe("completed");
});

test("dispatched uncertainty holds the reservation and cannot reroll", async () => {
	const f = invocationFixture();
	f.model.onComplete = async () => {
		throw Error("Connection vanished after dispatch");
	};
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/vanished/);
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/attention/);
	expect(f.model.requests).toHaveLength(1);
	expect(f.step.models[0]?.status).toBe("unknown");
	expect(f.step.models[0]?.reservation.inputTokens).toBe(16666);
});

test("deadline aborts native work and records uncertainty before returning", async () => {
	const f = invocationFixture(),
		entered = deferred<void>();
	f.model.onComplete = async (_request, signal) => {
		entered.resolve();
		await new Promise<void>((_yes, no) =>
			signal.addEventListener("abort", () => no(signal.reason), { once: true }),
		);
		throw Error("unreachable");
	};
	const call = invokeLifeModel(f.context, "actor", "lina", prompt);
	await entered.promise;
	f.clock.advance(60_000);
	await expect(call).rejects.toThrow(/deadline/);
	expect(f.step.models[0]?.status).toBe("unknown");
	expect(f.clock.pending).toBe(0);
});

test("a late known result stays accounted but cannot ignore the deadline", async () => {
	const f = invocationFixture();
	f.model.onComplete = async (request) => {
		f.clock.advance(60_000);
		await Promise.resolve();
		return f.model.result(request);
	};
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/deadline/);
	expect(f.step.models[0]?.status).toBe("completed");
	expect(f.step.models[0]?.usage.totalTokens).toBe(18);
});

test("missing usage holds a completed receipt and blocks further progress", async () => {
	const f = invocationFixture();
	f.model.onComplete = async (request) => ({
		...f.model.result(request),
		usage: { inputTokens: null, outputTokens: null, totalTokens: null },
	});
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/usage/);
	expect(f.step.models[0]?.status).toBe("completed");
	expect(f.step.models[0]?.prepared.request.id).toBe(
		lifeLaneId(f.step.id, "actor", "lina"),
	);
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/usage/);
	expect(f.model.requests).toHaveLength(1);
});

test("zero remaining tokens and unresolved usage block a new request", () => {
	const step = pureStep();
	step.source.config = runtimeConfig();
	const usage = {
		inputTokens: 100000,
		outputTokens: 0,
		reservedInputTokens: 0,
		reservedOutputTokens: 0,
		unknownRequests: 0,
		upstreamAttempts: 0,
		monetaryCost: "unknown" as const,
	};
	expect(() =>
		buildLifeRequest(step, "actor", "lina", usage, {
			systemPrompt: "trusted",
			input: "{}",
		}),
	).toThrow(/budget/i);
	expect(() =>
		buildLifeRequest(
			step,
			"actor",
			"lina",
			{ ...usage, inputTokens: 0, unknownRequests: 1 },
			{ systemPrompt: "trusted", input: "{}" },
		),
	).toThrow(/usage|budget/i);
});

test("observed usage over a reservation is retained and pauses the partial step", async () => {
	const f = invocationFixture();
	f.model.onComplete = async (request) => ({
		...f.model.result(request),
		usage: {
			inputTokens: request.request.limits.maxInputTokens + 1,
			outputTokens: 7,
			totalTokens: request.request.limits.maxInputTokens + 8,
		},
	});
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/reservation/);
	expect(f.step.models[0]?.usage.inputTokens).toBe(16667);
	expect(f.step.models[0]?.status).toBe("completed");
	expect(f.model.requests).toHaveLength(1);
});

test("cancel during native preparation drains before a reservation or dispatch", async () => {
	const f = invocationFixture(),
		entered = deferred<void>(),
		drained = deferred<void>();
	f.model.prepare = async (_request, signal) => {
		entered.resolve();
		try {
			await new Promise<void>((_yes, no) =>
				signal.addEventListener("abort", () => no(signal.reason), {
					once: true,
				}),
			);
		} finally {
			drained.resolve();
		}
		throw Error("unreachable");
	};
	const call = invokeLifeModel(f.context, "actor", "lina", prompt);
	await entered.promise;
	f.controller.abort(Error("cancel preparation"));
	await expect(call).rejects.toThrow(/cancel preparation/);
	await drained.promise;
	expect(f.step.models).toEqual([]);
	expect(f.model.requests).toEqual([]);
	expect(f.clock.pending).toBe(0);
});

test("a saved dispatch marker with no native proof remains unknown", async () => {
	const f = invocationFixture();
	const request = buildLifeRequest(
		f.step,
		"actor",
		"lina",
		f.context.store.lifeStatus(f.step.worldId, 0).usage,
		prompt(),
	);
	const prepared = await f.model.prepare(request, f.controller.signal);
	f.context.store.prepareLifeModel(f.step.lease, f.step.id, prepared, 0);
	f.context.store.dispatchLifeModel(f.step.lease, f.step.id, request.id, 0);
	await expect(
		invokeLifeModel(f.context, "actor", "lina", prompt),
	).rejects.toThrow(/attention/);
	expect(f.model.requests).toHaveLength(0);
	expect(f.step.models[0]?.status).toBe("unknown");
});

test("synthetic prepared model receipts obey the real core decoder", async () => {
	const f = invocationFixture();
	const request = buildLifeRequest(
		f.step,
		"actor",
		"lina",
		f.context.store.lifeStatus(f.step.worldId, 0).usage,
		prompt(),
	);
	const prepared = await f.model.prepare(request, f.controller.signal);
	expect(parsePreparedLifeModel(prepared)).toEqual(prepared);
});

test("real SQLite retains unknown and over-reservation usage across a later window without reroll", async () => {
	for (const mode of ["unknown", "overage"] as const) {
		const f = runtimeStoreFixture(false);
		try {
			f.model.onComplete = async (prepared) => {
				const result = f.model.result(prepared),
					input = prepared.request.limits.maxInputTokens + 1;
				return {
					...result,
					usage:
						mode === "unknown"
							? { inputTokens: null, outputTokens: null, totalTokens: null }
							: { inputTokens: input, outputTokens: 7, totalTokens: input + 7 },
				};
			};
			const first = await f.runner.run(
				"test-world",
				`usage-${mode}`,
				1,
				new AbortController().signal,
			);
			expect(first.status).toBe("needs_attention");
			expect(first.error).toBe("budget");
			expect(first.models[0]?.status).toBe("completed");
			f.clock.advance(1001);
			const next = await f.runner.run(
				"test-world",
				`usage-${mode}`,
				1,
				new AbortController().signal,
			);
			expect(next.status).toBe("needs_attention");
			expect(next.models[0]?.usage).toEqual(first.models[0]?.usage);
			expect(f.model.requests).toHaveLength(1);
			if (mode === "unknown") {
				const usage = f.store.lifeStatus("test-world", 1001).usage;
				expect(usage.unknownRequests).toBe(1);
				expect(usage.reservedInputTokens).toBe(16666);
			}
		} finally {
			await f.close();
		}
	}
});

test("frozen step requests carry lane selection and respect its output cap", async () => {
	const { lifeDigest } = await import("../../lina-core/src/world/life-json.ts");
	const f = invocationFixture();
	const step = f.step;
	step.version = 4;
	const resolve = (lane: "director" | "actor") => {
		const route = step.source.config.models?.[lane];
		if (!route) throw Error("Missing fixture route");
		const fields = {
			profileId: lane,
			...route,
			reasoning: "high" as const,
			maxOutputTokens: 23,
			settingsRevision: step.source.modelSettingsRevision,
		};
		return { ...fields, routeFingerprint: lifeDigest(fields) };
	};
	step.source.resolvedModels = {
		director: resolve("director"),
		actor: resolve("actor"),
	};
	const usage = f.context.store.lifeStatus(step.worldId, 0).usage;
	for (const lane of ["director", "actor", "target", "reflection"] as const) {
		const request = buildLifeRequest(step, lane, "lina", usage, prompt());
		expect(request.version).toBe(3);
		expect(request).toMatchObject({
			selection:
				step.source.resolvedModels[lane === "director" ? "director" : "actor"],
		});
		expect(request.limits.maxOutputTokens).toBe(23);
	}
	step.source.resolvedModels.actor = null;
	expect(() =>
		buildLifeRequest(step, "actor", "lina", usage, prompt()),
	).toThrow();
});
