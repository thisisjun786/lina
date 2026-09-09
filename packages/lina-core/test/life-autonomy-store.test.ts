import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { socialRequest } from "./life-social-store-fixture.ts";

test("quiet autonomous commit is atomic, restart stable and idempotent without reroll", () => {
	const f = autonomyStoreFixture();
	try {
		let draws = 0;
		const step = f.store.prepareLifeStep(f.request, () => {
			draws++;
			return 42;
		});
		expect(step.decision.kind).toBe("quiet");
		f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
		const ready = f.store.finishLifeStep(step.lease, step.id, f.clock());
		expect(ready.outcome?.commit.claims).toEqual([]);
		const receipt = f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.source.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		expect(receipt.lifeRevision).toBe(1);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			const replay = reopened.prepareLifeStep(f.request, () => {
				throw Error("rerolled");
			});
			expect(replay.status).toBe("accepted");
			expect(replay.outcome).toEqual(ready.outcome);
			expect(reopened.lifeSnapshot(f.request.worldId).revision).toBe(1);
			expect(draws).toBe(1);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("store clock fences stale owner and configuration rejects old acceptance", () => {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42);
		f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
		f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.advance(101);
		expect(() =>
			f.store.acceptLifeStep(
				step.lease,
				step.id,
				{ identity: f.source.identity, modelSettingsRevision: 1 },
				0,
			),
		).toThrow(/lease/i);
		const resumed = f.store.prepareLifeStep(
			{ ...f.request, owner: "new" },
			() => {
				throw Error("reroll");
			},
		);
		expect(resumed.id).toBe(step.id);
		expect(resumed.lease.token).toBeGreaterThan(step.lease.token);
		const { worldId: _world, revision: _revision, ...config } = f.source.config;
		f.store.setLifeConfig(f.request.worldId, 1, {
			...config,
			run: { mode: "paused" },
		});
		expect(() =>
			f.store.acceptLifeStep(
				resumed.lease,
				step.id,
				{ identity: f.source.identity, modelSettingsRevision: 1 },
				f.clock(),
			),
		).toThrow();
		expect(f.store.lifeSnapshot(f.request.worldId).revision).toBe(0);
	} finally {
		f.close();
	}
});

test("reopen rejects corrupted autonomous decision at startup", () => {
	const f = autonomyStoreFixture();
	try {
		f.store.prepareLifeStep(f.request, () => 42);
		f.store.close();
		const db = new DatabaseSync(f.path);
		db.exec(
			"UPDATE life_steps SET step_json = json_set(step_json, '$.decision.simulationTime', 900)",
		);
		db.close();
		expect(() => new WorldStore(f.path, f.clock)).toThrow(
			/autonom|step|corrupt/i,
		);
	} finally {
		f.close();
	}
});

test("scheduler can reserve a lease without creating an event or sampling entropy", () => {
	const f = autonomyStoreFixture();
	try {
		const lease = f.store.acquireLifeLease(
			f.request.worldId,
			1,
			"scheduler",
			0,
			100,
		);
		f.store.advanceLifeSchedule(lease, 0, 2000, 3);
		f.store.releaseLifeLease(lease, 0);
		expect(f.store.lifeSnapshot(f.request.worldId).revision).toBe(0);
		expect(f.store.lifeStatus(f.request.worldId, 0).schedule?.nextDue).toBe(
			2000,
		);
		expect(
			f.store.lifeStatus(f.request.worldId, 0).schedule?.lastSkippedIntervals,
		).toBe(3);
		expect(f.store.lifeStatus(f.request.worldId, 0).activeStepId).toBeNull();
		expect(() =>
			f.store.acquireLifeLease(f.request.worldId, 2, "scheduler", 0, 100),
		).toThrow(/config|revision/i);
	} finally {
		f.close();
	}
});

test("manual social preparation remains inspectable after autonomous ownership starts", () => {
	const f = autonomyStoreFixture();
	try {
		const request = socialRequest();
		const pending = f.store.prepareSocialResolution(request, () => 7);
		f.store.prepareLifeStep(f.request, () => 42);
		expect(
			f.store.socialResolution(request.worldId, request.requestId),
		).toEqual(pending);
		expect(() =>
			f.store.prepareSocialResolution(
				{ ...request, requestId: "new-manual" },
				() => 7,
			),
		).toThrow(/autonom/i);
	} finally {
		f.close();
	}
});

test("new step freezes exact model selections and restores accepted work v2", () => {
	const f = autonomyStoreFixture();
	try {
		const resolvedModels = frozenModels(f);
		const request = { ...f.request, resolvedModels };
		const step = f.store.prepareLifeStep(request, () => 1);
		expect(step.version).toBe(4);
		expect(step.source.resolvedModels).toEqual(request.resolvedModels);
		expect(step.source.work?.version).toBe(2);
		f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
		f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.source.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		const accepted = f.store.lifeStep(request.worldId, step.id);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeStep(request.worldId, step.id)).toEqual(accepted);
			expect(
				reopened.prepareLifeStep(request, () => {
					throw Error("must replay");
				}),
			).toMatchObject({ id: step.id, source: step.source });
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

function frozenModels(f: ReturnType<typeof autonomyStoreFixture>) {
	const resolve = (lane: "director" | "actor") => {
		const configured = f.source.config.models?.[lane];
		if (!configured) return null;
		const exact = {
			profileId: `world-${lane}`,
			...configured,
			reasoning: "off" as const,
			maxOutputTokens: null,
			settingsRevision: 1,
		};
		return { ...exact, routeFingerprint: lifeDigest(exact) };
	};
	return { director: resolve("director"), actor: resolve("actor") };
}

test("invalid frozen lanes roll back work upgrade and reject replay selection drift", () => {
	const f = autonomyStoreFixture();
	try {
		const resolvedModels = frozenModels(f);
		expect(() =>
			f.store.prepareLifeStep(
				{ ...f.request, resolvedModels: { ...resolvedModels, actor: null } },
				() => 1,
			),
		).toThrow(/model source mismatch/);
		const db = new DatabaseSync(f.path);
		try {
			expect(
				db
					.prepare(
						"SELECT count(*) AS n FROM life_work_history WHERE event_json LIKE '%upgrade%'",
					)
					.get()?.["n"],
			).toBe(0);
		} finally {
			db.close();
		}
		f.store.prepareLifeStep({ ...f.request, resolvedModels }, () => 1);
		const actor = resolvedModels.actor;
		if (!actor) throw Error("fixture requires actor");
		const { routeFingerprint: _digest, ...selection } = actor;
		const changed = { ...selection, reasoning: "high" as const };
		expect(() =>
			f.store.prepareLifeStep(
				{
					...f.request,
					resolvedModels: {
						...resolvedModels,
						actor: { ...changed, routeFingerprint: lifeDigest(changed) },
					},
				},
				() => 1,
			),
		).toThrow(/idempotency conflict/);
	} finally {
		f.close();
	}
});
