import { expect, test } from "bun:test";
import type {
	LifeModelResult,
	LifeStep,
	PreparedLifeModelRequest,
} from "../src/world/autonomy-types.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	activateBaseline,
	migrationFixture,
	nextPack,
	proposePack,
} from "./life-autonomy-migration-fixture.ts";

function director(step: LifeStep): PreparedLifeModelRequest {
	const agentId = step.decision.agentId,
		route = step.source.config.models?.director;
	if (!agentId || !route) throw Error("Missing fixture actor route");
	const request = {
		version: 1 as const,
		id: "migration-director",
		worldId: step.worldId,
		stepId: step.id,
		lane: "director" as const,
		agentId,
		...route,
		modelSettingsRevision: 1,
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
		nativeReference: "migration-native",
	};
}
function result(p: PreparedLifeModelRequest): LifeModelResult {
	return {
		version: 1,
		requestId: p.request.id,
		inputDigest: p.inputDigest,
		capabilityFingerprint: p.capabilityFingerprint,
		nativeReference: p.nativeReference,
		provider: p.request.provider,
		model: p.request.model,
		threadId: "migration-thread",
		turnId: "migration-turn",
		text: "A synthetic opportunity",
		usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
		upstreamAttempts: 1,
	};
}

test("pack activation fences an unfinished quiet step and permits a new owner at the migrated boundary", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		const step = f.store.prepareLifeStep(f.request, () => 42);
		f.store.activateWorldDraft(proposePack(f.store, nextPack(f)).confirmation);
		expect(f.store.lifeStep(step.worldId, step.id).status).toBe("stale");
		expect(f.store.lifeStatus(step.worldId, 1000).activeStepId).toBeNull();
		const next = f.store.prepareLifeStep(
			{ ...f.request, owner: "new-owner", idempotencyKey: "new-pack-step" },
			() => 99,
		);
		expect(next.source.autonomy).toMatchObject({
			packVersion: 2,
			lifeRevision: 1,
			worldRevision: 1,
			stepNumber: 0,
			seed: 42,
			selectionIndex: 0,
		});
		expect(next.lease.generation).toBeGreaterThan(step.lease.generation);
		expect(() => f.store.finishLifeStep(step.lease, step.id, 1000)).toThrow(
			/stale/i,
		);
	} finally {
		f.close();
	}
});

for (const status of ["prepared", "dispatched", "completed"] as const)
	test(`pack migration retains ${status} model accounting without keeping the old step active`, () => {
		const f = migrationFixture();
		try {
			f.pack.autonomy.events = structuredClone(f.source.pack.autonomy.events);
			f.pack.autonomy.quietWeight = 0;
			f.pack.rules = [];
			activateBaseline(f);
			const step = f.store.prepareLifeStep(f.request, () => 42),
				p = director(step);
			f.store.prepareLifeModel(step.lease, step.id, p, 1000);
			if (status !== "prepared")
				f.store.dispatchLifeModel(step.lease, step.id, p.request.id, 1000);
			if (status === "completed")
				f.store.finishLifeModel(
					step.worldId,
					step.id,
					p.request.id,
					{ status: "completed", result: result(p) },
					1000,
				);
			f.store.activateWorldDraft(
				proposePack(f.store, nextPack(f)).confirmation,
			);
			const saved = f.store.lifeStep(step.worldId, step.id),
				run = f.store.lifeStatus(step.worldId, 1000);
			expect(saved.status).toBe("stale");
			expect(run.activeStepId).toBeNull();
			expect(saved.models).toHaveLength(1);
			if (status === "prepared") {
				expect(saved.models[0]).toMatchObject({
					status: "failed",
					upstreamAttempts: 0,
				});
				expect(run.usage.reservedInputTokens).toBe(0);
			} else if (status === "dispatched") {
				expect(run.usage.reservedInputTokens).toBe(100);
				expect(run.usage.unknownRequests).toBe(1);
				f.store.finishLifeModel(
					step.worldId,
					step.id,
					p.request.id,
					{ status: "completed", result: result(p) },
					1000,
				);
				expect(f.store.lifeStep(step.worldId, step.id).status).toBe("stale");
				expect(f.store.lifeStatus(step.worldId, 1000).usage).toMatchObject({
					inputTokens: 10,
					outputTokens: 20,
					reservedInputTokens: 0,
					unknownRequests: 0,
				});
			} else
				expect(run.usage).toMatchObject({
					inputTokens: 10,
					outputTokens: 20,
					reservedInputTokens: 0,
				});
			f.store.close();
			const reopened = new WorldStore(f.path, f.clock);
			try {
				expect(reopened.lifeStep(step.worldId, step.id).status).toBe("stale");
			} finally {
				reopened.close();
			}
		} finally {
			f.close();
		}
	});
