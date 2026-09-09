import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { completedLifeModelText } from "../src/world/autonomy-model-text.ts";
import type {
	LifeStep,
	PreparedLifeModelRequest,
	StepModelRequest,
} from "../src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function request(
	step: LifeStep,
): PreparedLifeModelRequest & { request: StepModelRequest } {
	const agentId = step.decision.agentId;
	if (!agentId) throw Error("Expected active fixture");
	const route = step.source.config.models?.director;
	if (!route) throw Error("Missing fixture route");
	const request = {
		version: 1 as const,
		id: "request-one",
		worldId: step.worldId,
		stepId: step.id,
		lane: "director" as const,
		agentId,
		...route,
		modelSettingsRevision: step.source.modelSettingsRevision,
		...buildLifeModelInput(step, "director", agentId),
		limits: {
			maxInputTokens: 100,
			maxOutputTokens: 100,
			maxInputBytes: 100000,
			maxOutputBytes: 10000,
			timeoutMs: 1000,
		},
	};
	return {
		version: 1,
		request,
		inputDigest: lifeDigest(request),
		capabilityFingerprint: "a".repeat(64),
		nativeReference: "native-one",
	};
}

test("terminal reconciliation cannot erase an attempt proven by uncertain recovery", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		f.store.prepareLifeModel(step.lease, step.id, p, f.clock());
		f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock());
		const usage = { inputTokens: null, outputTokens: null, totalTokens: null };
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{ status: "unknown", usage, upstreamAttempts: 1 },
			f.clock(),
		);
		const before = f.store.lifeStatus(step.worldId, f.clock()).usage;
		expect(() =>
			f.store.finishLifeModel(
				step.worldId,
				step.id,
				p.request.id,
				{
					status: "failed",
					usage,
					upstreamAttempts: 0,
					reason: "uncertain failure",
				},
				f.clock(),
			),
		).toThrow(/attempt|accounting/i);
		expect(f.store.lifeStatus(step.worldId, f.clock()).usage).toEqual(before);
		expect(before).toMatchObject({
			reservedInputTokens: 100,
			reservedOutputTokens: 100,
			upstreamAttempts: 1,
			unknownRequests: 1,
		});
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeStatus(step.worldId, f.clock()).usage).toEqual(
				before,
			);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("uncertain native outcome still recovers proven usage and attempts", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		f.store.prepareLifeModel(step.lease, step.id, p, f.clock());
		f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock());
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{
				status: "unknown",
				usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
				upstreamAttempts: 1,
			},
			f.clock(),
		);
		const usage = f.store.lifeStatus(step.worldId, f.clock()).usage;
		expect(usage).toMatchObject({
			inputTokens: 31,
			outputTokens: 7,
			unknownRequests: 1,
			upstreamAttempts: 1,
		});
		expect(f.store.lifeSnapshot(step.worldId).revision).toBe(0);
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{ status: "unknown" },
			f.clock(),
		);
		expect(f.store.lifeStatus(step.worldId, f.clock()).usage).toEqual(usage);
	} finally {
		f.close();
	}
});

test("a request ID owned by a failed step cannot overwrite its ledger from a new step", () => {
	const f = autonomyStoreFixture(false);
	try {
		const first = f.store.prepareLifeStep(f.request, () => 42),
			p = request(first);
		f.store.prepareLifeModel(first.lease, first.id, p, f.clock());
		f.store.failLifeStep(
			first.lease,
			first.id,
			"invalid_model_output",
			f.clock(),
		);
		const second = f.store.prepareLifeStep(
			{ ...f.request, idempotencyKey: "second-step" },
			() => {
				throw Error("Repeated entropy");
			},
		);
		expect(() =>
			f.store.prepareLifeModel(
				second.lease,
				second.id,
				request(second),
				f.clock(),
			),
		).toThrow(/request|conflict|step/i);
		expect(
			f.store.lifeStep(first.worldId, first.id).models[0]?.prepared.request,
		).toMatchObject({ version: 1, stepId: first.id });
		expect(f.store.lifeStep(second.worldId, second.id).models).toHaveLength(0);
	} finally {
		f.close();
	}
});

test("dispatch is durable once, unknown reservation crosses windows and stale result remains accounted", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		f.store.prepareLifeModel(step.lease, step.id, p, f.clock());
		expect(
			f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock())
				.dispatched,
		).toBe(true);
		expect(
			f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock())
				.dispatched,
		).toBe(false);
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{ status: "unknown" },
			f.clock(),
		);
		f.advance(2000);
		const usage = f.store.lifeStatus(step.worldId, f.clock()).usage;
		expect(usage.unknownRequests).toBe(1);
		expect(usage.reservedInputTokens).toBe(100);
		const { worldId: _world, revision: _revision, ...config } = f.source.config;
		f.store.setLifeConfig(step.worldId, 1, {
			...config,
			run: { mode: "paused" },
		});
		const result = {
			version: 1 as const,
			requestId: p.request.id,
			inputDigest: p.inputDigest,
			capabilityFingerprint: p.capabilityFingerprint,
			nativeReference: p.nativeReference,
			provider: p.request.provider,
			model: p.request.model,
			threadId: "thread",
			turnId: "turn",
			text: "A synthetic opportunity",
			usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
			upstreamAttempts: 1 as const,
		};
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{ status: "completed", result },
			f.clock(),
		);
		// The late result belongs to the earlier dispatch window, but cannot revive a stale step.
		expect(
			f.store.lifeStep(step.worldId, step.id).models[0]?.usage.inputTokens,
		).toBe(120);
		expect(f.store.lifeStep(step.worldId, step.id).status).toBe("stale");
		expect(
			f.store.lifeStatus(step.worldId, f.clock()).usage.unknownRequests,
		).toBe(0);
		expect(f.store.lifeSnapshot(step.worldId).revision).toBe(0);
	} finally {
		f.close();
	}
});

test("unscoped model prompt and alternate route cannot reserve or dispatch", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		for (const patch of [
			{ input: "SECRET_UNSCOPED_INPUT" },
			{ provider: "other" },
		]) {
			const changed = { ...p.request, ...patch };
			expect(() =>
				f.store.prepareLifeModel(
					step.lease,
					step.id,
					{ ...p, request: changed, inputDigest: lifeDigest(changed) },
					f.clock(),
				),
			).toThrow();
		}
		expect(f.store.lifeStep(step.worldId, step.id).models).toHaveLength(0);
	} finally {
		f.close();
	}
});

test("a completed over-reservation model cannot fund another lane even with remaining window budget", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		f.store.prepareLifeModel(step.lease, step.id, p, f.clock());
		f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock());
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			p.request.id,
			{
				status: "completed",
				result: {
					version: 1,
					requestId: p.request.id,
					inputDigest: p.inputDigest,
					capabilityFingerprint: p.capabilityFingerprint,
					nativeReference: p.nativeReference,
					provider: p.request.provider,
					model: p.request.model,
					threadId: "thread",
					turnId: "turn",
					text: "An opportunity",
					usage: { inputTokens: 101, outputTokens: 1, totalTokens: 102 },
					upstreamAttempts: 1,
				},
			},
			f.clock(),
		);
		const current = f.store.lifeStep(step.worldId, step.id),
			route = f.source.config.models?.actor;
		if (!route) throw Error("Missing fixture route");
		const actor = {
			...p.request,
			...route,
			id: "actor-next",
			lane: "actor" as const,
			...buildLifeModelInput(current, "actor", p.request.agentId),
		};
		expect(() =>
			f.store.prepareLifeModel(
				step.lease,
				step.id,
				{ ...p, request: actor, inputDigest: lifeDigest(actor) },
				f.clock(),
			),
		).toThrow(/usage|reservation|budget/i);
		expect(f.store.lifeStep(step.worldId, step.id).models).toHaveLength(1);
	} finally {
		f.close();
	}
});

test("a fully reserved prepared request remains resumable before dispatch", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		const budget = f.source.config.usage;
		if (!budget) throw Error("Missing fixture budget");
		const all = {
			...p.request,
			limits: {
				...p.request.limits,
				maxInputTokens: budget.maxInputTokens,
				maxOutputTokens: budget.maxOutputTokens,
			},
		};
		f.store.prepareLifeModel(
			step.lease,
			step.id,
			{ ...p, request: all, inputDigest: lifeDigest(all) },
			f.clock(),
		);
		expect(f.store.lifeStatus(step.worldId, f.clock()).status).toBe("running");
		expect(
			f.store.dispatchLifeModel(step.lease, step.id, p.request.id, f.clock())
				.dispatched,
		).toBe(true);
	} finally {
		f.close();
	}
});

test("configuration change releases only proven undispatched reservations and retains their ledger", () => {
	const f = autonomyStoreFixture(false);
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42),
			p = request(step);
		f.store.prepareLifeModel(step.lease, step.id, p, f.clock());
		const { worldId: _world, revision: _revision, ...config } = f.source.config;
		f.store.setLifeConfig(step.worldId, 1, config);
		const saved = f.store.lifeStep(step.worldId, step.id);
		expect(saved.status).toBe("stale");
		expect(saved.models[0]?.status).toBe("failed");
		expect(saved.models[0]?.upstreamAttempts).toBe(0);
		expect(
			f.store.lifeStatus(step.worldId, f.clock()).usage.reservedInputTokens,
		).toBe(0);
	} finally {
		f.close();
	}
});

test("frozen step owns exact request selection and restores its reservation", () => {
	const f = autonomyStoreFixture(false);
	try {
		const resolve = (lane: "director" | "actor") => {
			const route = f.source.config.models?.[lane];
			if (!route) return null;
			const selected = {
				profileId: `world-${lane}`,
				...route,
				reasoning: "low" as const,
				maxOutputTokens: 100,
				settingsRevision: 1,
			};
			return { ...selected, routeFingerprint: lifeDigest(selected) };
		};
		const resolvedModels = {
			director: resolve("director"),
			actor: resolve("actor"),
		};
		const step = f.store.prepareLifeStep(
			{ ...f.request, resolvedModels },
			() => 42,
		);
		const base = request(step);
		const selection = resolvedModels.director;
		if (!selection) throw Error("Missing fixture director");
		const frozen = { ...base.request, version: 3 as const, selection };
		const prepared = {
			...base,
			request: frozen,
			inputDigest: lifeDigest(frozen),
		};
		expect(() =>
			f.store.prepareLifeModel(step.lease, step.id, base, f.clock()),
		).toThrow();
		const { routeFingerprint: _hash, ...chosen } = selection;
		const changed = { ...chosen, reasoning: "high" as const };
		const drift = {
			...frozen,
			selection: { ...changed, routeFingerprint: lifeDigest(changed) },
		};
		expect(() =>
			f.store.prepareLifeModel(
				step.lease,
				step.id,
				{ ...base, request: drift, inputDigest: lifeDigest(drift) },
				f.clock(),
			),
		).toThrow();
		const saved = f.store.prepareLifeModel(
			step.lease,
			step.id,
			prepared,
			f.clock(),
		);
		expect(saved.prepared).toEqual(prepared);
		f.store.dispatchLifeModel(step.lease, step.id, frozen.id, f.clock());
		f.store.assertLifeModelOutbound(frozen);
		expect(() => f.store.assertLifeModelOutbound(base.request)).toThrow();
		expect(() => f.store.assertLifeModelOutbound(drift)).toThrow();
		f.store.finishLifeModel(
			step.worldId,
			step.id,
			frozen.id,
			{
				status: "completed",
				result: {
					version: 1,
					requestId: frozen.id,
					inputDigest: prepared.inputDigest,
					capabilityFingerprint: prepared.capabilityFingerprint,
					nativeReference: prepared.nativeReference,
					provider: frozen.provider,
					model: frozen.model,
					threadId: "synthetic",
					turnId: "synthetic",
					text: "Frozen opportunity",
					usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
					upstreamAttempts: 1,
				},
			},
			f.clock(),
		);
		const finished = f.store.lifeStep(step.worldId, step.id);
		expect(completedLifeModelText(finished, "director", frozen.agentId)).toBe(
			"Frozen opportunity",
		);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeStep(step.worldId, step.id).models[0]).toEqual(
				finished.models[0],
			);
		} finally {
			reopened.close();
		}
		// A self-consistent receipt hash cannot authorize a different frozen profile.
		const db = new DatabaseSync(f.path);
		try {
			const record = structuredClone(finished.models[0]);
			if (!record) throw Error("Missing receipt");
			record.prepared.request = drift;
			record.prepared.inputDigest = lifeDigest(drift);
			if (record.result) record.result.inputDigest = lifeDigest(drift);
			db.prepare(
				"UPDATE life_model_receipts SET record_json=?,digest=? WHERE request_id=?",
			).run(JSON.stringify(record), lifeDigest(record), frozen.id);
		} finally {
			db.close();
		}
		expect(() => new WorldStore(f.path, f.clock)).toThrow(/selection mismatch/);
	} finally {
		f.close();
	}
});
