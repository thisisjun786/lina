import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

for (const table of [
	"life_autonomy_state",
	"life_steps",
	"life_schedules",
] as const) {
	test(`failure writing ${table} rolls back the entire autonomous acceptance`, () => {
		const f = autonomyStoreFixture();
		try {
			const step = f.store.prepareLifeStep(f.request, () => 42);
			f.store.prepareLifeObservations(step.lease, step.id, null, f.clock());
			f.store.finishLifeStep(step.lease, step.id, f.clock());
			const db = new DatabaseSync(f.path);
			try {
				const before = db
					.prepare("SELECT state_json FROM life_autonomy_state")
					.get();
				db.exec(
					`CREATE TRIGGER fail_accept BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic acceptance fault'); END`,
				);
				expect(() =>
					f.store.acceptLifeStep(
						step.lease,
						step.id,
						{ identity: f.source.identity, modelSettingsRevision: 1 },
						f.clock(),
					),
				).toThrow(/synthetic acceptance fault/);
				expect(f.store.lifeSnapshot(step.worldId).revision).toBe(0);
				expect(f.store.snapshot(step.worldId).revision).toBe(0);
				expect(f.store.lifeStep(step.worldId, step.id).status).toBe("ready");
				expect(
					db.prepare("SELECT state_json FROM life_autonomy_state").get(),
				).toEqual(before);
				expect(
					db.prepare("SELECT COUNT(*) AS n FROM life_commits").get(),
				).toEqual({ n: 0 });
				db.exec("DROP TRIGGER fail_accept");
				const receipt = f.store.acceptLifeStep(
					step.lease,
					step.id,
					{ identity: f.source.identity, modelSettingsRevision: 1 },
					f.clock(),
				);
				expect(receipt.lifeRevision).toBe(1);
				expect(
					f.store.acceptLifeStep(
						step.lease,
						step.id,
						{ identity: f.source.identity, modelSettingsRevision: 1 },
						f.clock(),
					).replayed,
				).toBe(true);
				expect(
					db.prepare("SELECT COUNT(*) AS n FROM life_commits").get(),
				).toEqual({ n: 1 });
			} finally {
				db.close();
			}
		} finally {
			f.close();
		}
	});
}
