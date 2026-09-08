import { expect, test } from "bun:test";
import { WorldStore } from "../src/world/store.ts";
import {
	activateBaseline,
	migrationFixture,
	nextPack,
	proposePack,
} from "./life-autonomy-migration-fixture.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

test("current identity invalidation fences an expired pending step once and survives reopen", () => {
	const f = autonomyStoreFixture();
	try {
		const step = f.store.prepareLifeStep(f.request, () => 42);
		const current = {
			identity: f.source.identity,
			profiles: f.source.profiles,
			modelSettingsRevision: 1,
		};
		const before = f.store.lifeStatus(step.worldId, f.clock());
		f.store.invalidateLifeIdentity(step.worldId, current, f.clock());
		expect(f.store.lifeStatus(step.worldId, f.clock())).toEqual(before);
		f.advance(101);
		const changed = { ...current, modelSettingsRevision: 2 };
		f.store.invalidateLifeIdentity(step.worldId, changed, f.clock());
		expect(f.store.lifeStep(step.worldId, step.id).status).toBe("stale");
		const status = f.store.lifeStatus(step.worldId, f.clock());
		expect(status).toMatchObject({
			status: "ready",
			activeStepId: null,
			schedule: {
				generation: step.lease.generation + 1,
				lease: null,
				nextDue: null,
			},
		});
		f.store.invalidateLifeIdentity(step.worldId, changed, f.clock());
		expect(f.store.lifeStatus(step.worldId, f.clock())).toEqual(status);
		expect(() =>
			f.store.finishLifeStep(step.lease, step.id, f.clock()),
		).toThrow(/lease|stale/i);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeStep(step.worldId, step.id).status).toBe("stale");
			const next = reopened.prepareLifeStep(
				{ ...f.request, ...changed, idempotencyKey: "fresh-model-settings" },
				() => {
					throw Error("Seed resampled");
				},
			);
			expect(next.source.modelSettingsRevision).toBe(2);
			expect(next.source.autonomy.seed).toBe(42);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("confirmed pack changes fence pending steps and reset scheduling without changing user cadence", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		const step = f.store.prepareLifeStep(f.request, () => 42);
		f.store.advanceLifeSchedule(step.lease, 1000, 2000, 0);
		const before = f.store.lifeConfig(step.worldId);
		const proposal = proposePack(f.store, nextPack(f));
		f.store.activateWorldDraft(proposal.confirmation);
		expect(f.store.lifeStep(step.worldId, step.id).status).toBe("stale");
		const status = f.store.lifeStatus(step.worldId, 1000);
		expect(status.schedule?.generation).toBe(step.lease.generation + 1);
		expect(status.schedule?.lease).toBeNull();
		expect(status.schedule?.nextDue).toBeNull();
		expect(f.store.lifeConfig(step.worldId)).toEqual(before);
		const next = f.store.prepareLifeStep(
			{ ...f.request, idempotencyKey: "new-pack-step" },
			() => {
				throw Error("Resampled seed");
			},
		);
		expect(next.source.pack.version).toBe(2);
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
