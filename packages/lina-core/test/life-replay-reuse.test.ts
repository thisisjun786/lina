import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import type { LifePersistence } from "../src/world/life-persistence.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

function acceptedFixture() {
	const f = autonomyStoreFixture();
	const step = f.store.prepareLifeStep(f.request, () => 42);
	f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
	f.store.finishLifeStep(step.lease, step.id, f.clock());
	const receipt = f.store.acceptLifeStep(
		step.lease,
		step.id,
		{
			identity: f.source.identity,
			modelSettingsRevision: 1,
		},
		f.clock(),
	);
	return { ...f, step, receipt };
}

test("a write inside the replay transaction invalidates a warm revision and rollback clears it", () => {
	const f = acceptedFixture();
	try {
		// Privileged corruption harness: exercise the actual SQL owner inside its
		// existing transaction without exposing a mutation API in production.
		const db = Reflect.get(f.store, "db") as DatabaseSync;
		const life = Reflect.get(f.store, "life") as LifePersistence;
		const transaction = Reflect.get(f.store, "transaction") as (
			action: () => void,
		) => void;
		const original = f.store.lifeSnapshotAt(
			f.step.worldId,
			f.receipt.lifeRevision,
		);
		expect(() =>
			transaction.call(f.store, () => {
				life.snapshotAt(f.step.worldId, f.receipt.lifeRevision);
				db.exec(
					"UPDATE life_commits SET envelope_json=json_set(envelope_json,'$.commit.stepId','forged') WHERE life_revision=(SELECT max(life_revision) FROM life_commits)",
				);
				life.snapshotAt(f.step.worldId, f.receipt.lifeRevision);
			}),
		).toThrow("Corrupt LIFE commit provenance");
		expect(
			f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision),
		).toEqual(original);
	} finally {
		f.close();
	}
});

test("repeated historical reads isolate returned objects from later readers", () => {
	const f = acceptedFixture();
	try {
		const original = f.store.lifeSnapshotAt(
			f.step.worldId,
			f.receipt.lifeRevision,
		);
		const changed = f.store.lifeSnapshotAt(
			f.step.worldId,
			f.receipt.lifeRevision,
		);
		changed.revision = 999;
		const step = f.store.lifeStep(f.step.worldId, f.step.id);
		const profile = step.source.profiles[0];
		if (!profile) throw Error("Missing fixture profile");
		const originalName = profile.name;
		profile.name = "caller mutation";
		const pack = f.store.worldPack(f.step.worldId);
		pack.background.authoredText = "caller mutation";
		expect(
			f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision),
		).toEqual(original);
		expect(
			f.store.lifeStep(f.step.worldId, f.step.id).source.profiles[0]?.name,
		).toBe(originalName);
		expect(f.store.worldPack(f.step.worldId).background.authoredText).not.toBe(
			"caller mutation",
		);
	} finally {
		f.close();
	}
});

for (const [name, sql] of [
	[
		"step bytes with retained digest",
		"UPDATE life_steps SET step_json=json_set(step_json,'$.decision.simulationTime',999)",
	],
	[
		"paired commit bytes with retained digest",
		"UPDATE life_commits SET envelope_json=json_set(envelope_json,'$.commit.stepId','forged') WHERE life_revision=(SELECT max(life_revision) FROM life_commits)",
	],
	["missing autonomy baseline", "DELETE FROM life_autonomy_state"],
	[
		"pack bytes with retained digest",
		"UPDATE world_packs SET pack_json=json_set(pack_json,'$.background.authoredText','forged')",
	],
] as const) {
	test(`warm historical reads detect ${name} from another connection`, () => {
		const f = acceptedFixture();
		const db = new DatabaseSync(f.path);
		try {
			f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision);
			f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision);
			db.exec("BEGIN");
			db.exec(sql);
			db.exec("ROLLBACK");
			expect(
				f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision).revision,
			).toBe(f.receipt.lifeRevision);
			db.exec(sql);
			expect(() =>
				f.store.lifeSnapshotAt(f.step.worldId, f.receipt.lifeRevision),
			).toThrow();
		} finally {
			db.close();
			f.close();
		}
	});
}
