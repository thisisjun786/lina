import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { LifeModelReceipts } from "../src/world/autonomy-model-receipts.ts";
import { AutonomyHistory } from "../src/world/autonomy-replay.ts";
import { LifeStepRecords } from "../src/world/autonomy-step-records.ts";
import type { LifeStep } from "../src/world/autonomy-types.ts";
import { selectLifeEvent } from "../src/world/events.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	acceptQuiet,
	activateBaseline,
	migrationFixture,
	nextPack,
	proposePack,
	sidecar,
} from "./life-autonomy-migration-fixture.ts";

for (const withMigration of [false, true])
	test(`history uses only a baseline LIFE lookup with migration=${withMigration}`, () => {
		const f = migrationFixture();
		try {
			activateBaseline(f);
			const first = acceptQuiet(f),
				before = sidecar(f.path);
			if (withMigration)
				f.store.activateWorldDraft(
					proposePack(f.store, nextPack(f)).confirmation,
				);
			const after = sidecar(f.path),
				db = new DatabaseSync(f.path),
				calls: number[] = [];
			try {
				const records = new LifeStepRecords(
					db,
					new LifeModelReceipts(db, f.clock),
				);
				const history = new AutonomyHistory(db, {
					sourceAt: (worldId, rev) => {
						calls.push(rev);
						if (rev !== 0) throw Error("Non-baseline LIFE lookup");
						return {
							world: f.store.snapshotAt(worldId, 0),
							life: f.store.lifeSnapshotAt(worldId, 0),
						};
					},
					worldAt: (id, rev) => f.store.snapshotAt(id, rev),
					pack: (id, version) => f.store.worldPack(id, version),
					step: (id, stepId) => records.get(id, stepId),
					social: () => {
						throw Error("No social request in quiet history");
					},
				});
				expect(history.stateAt(f.pack.worldId, 0)).toEqual(
					first.source.autonomy,
				);
				expect(history.stateAt(f.pack.worldId, 1)).toEqual(before);
				expect(before.variables["count"]).toBe(7);
				expect(first.source.autonomy.variables["count"]).toBe(1);
				if (withMigration)
					expect(history.stateAt(f.pack.worldId, 2)).toEqual(after);
				expect(calls).toEqual(withMigration ? [0, 0, 0] : [0, 0]);
				expect(() =>
					history.stateAt(f.pack.worldId, withMigration ? 3 : 2),
				).toThrow(/Missing/);
			} finally {
				db.close();
			}
		} finally {
			f.close();
		}
	});

for (const status of ["prepared", "failed"] as const)
	test(`rehashed ${status} source plus decision cannot replace historical autonomy`, () => {
		const f = migrationFixture();
		try {
			activateBaseline(f);
			const step = f.store.prepareLifeStep(f.request, () => 42);
			if (status === "failed")
				f.store.failLifeStep(step.lease, step.id, "invalid_model_output", 1000);
			const db = new DatabaseSync(f.path);
			try {
				const row = db.prepare("SELECT step_json FROM life_steps").get() as {
					step_json: string;
				};
				const forged = JSON.parse(row.step_json) as LifeStep;
				forged.source.autonomy.variables["count"] = 6;
				forged.decision = selectLifeEvent(forged.source, forged.id);
				db.prepare("UPDATE life_steps SET step_json=?,digest=?").run(
					canonicalLifeJson(forged),
					lifeDigest(forged),
				);
			} finally {
				db.close();
			}
			expect(() => f.store.lifeStep(step.worldId, step.id)).toThrow(
				/autonom|history/i,
			);
			f.store.close();
			expect(() => new WorldStore(f.path, f.clock)).toThrow(/autonom|history/i);
		} finally {
			f.close();
		}
	});

test("a rehashed definition migration receipt is replayed against the preceding accepted state", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		acceptQuiet(f);
		f.store.activateWorldDraft(proposePack(f.store, nextPack(f)).confirmation);
		f.store.close();
		const db = new DatabaseSync(f.path);
		try {
			const row = db
				.prepare("SELECT envelope_json FROM life_commits WHERE life_revision=2")
				.get() as { envelope_json: string };
			const envelope = JSON.parse(row.envelope_json);
			envelope.autonomyMigration.nextStateDigest = "0".repeat(64);
			const { digest: _, ...body } = envelope.autonomyMigration;
			envelope.autonomyMigration.digest = lifeDigest(body);
			db.prepare(
				"UPDATE life_commits SET envelope_json=?,input_digest=? WHERE life_revision=2",
			).run(canonicalLifeJson(envelope), lifeDigest(envelope));
		} finally {
			db.close();
		}
		expect(() => new WorldStore(f.path, f.clock)).toThrow(/autonom|migration/i);
	} finally {
		f.close();
	}
});

test("definition changes before the first prepared step retain null autonomy migration on reopen", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		const p = proposePack(f.store, nextPack(f));
		expect(p.preview).toMatchObject({ version: 3, autonomyMigration: null });
		f.store.activateWorldDraft(p.confirmation);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeSnapshot(f.pack.worldId).revision).toBe(1);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("rehashing the stored activation preview and confirmation cannot authorize a different migration result", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		acceptQuiet(f);
		f.store.activateWorldDraft(proposePack(f.store, nextPack(f)).confirmation);
		f.store.close();
		const db = new DatabaseSync(f.path);
		try {
			const row = db
				.prepare(
					"SELECT confirmation_json,receipt_json FROM world_activations WHERE idempotency_key='activate-2'",
				)
				.get() as { confirmation_json: string; receipt_json: string };
			const confirmation = JSON.parse(row.confirmation_json),
				receipt = JSON.parse(row.receipt_json);
			receipt.preview.autonomyMigration.nextStateDigest = "0".repeat(64);
			const { digest: _migration, ...migration } =
				receipt.preview.autonomyMigration;
			receipt.preview.autonomyMigration.digest = lifeDigest(migration);
			const { digest: _preview, ...preview } = receipt.preview;
			receipt.preview.digest = lifeDigest(preview);
			confirmation.previewDigest = receipt.preview.digest;
			receipt.inputDigest = lifeDigest(confirmation);
			db.prepare(
				"UPDATE world_activations SET confirmation_json=?,receipt_json=?,input_digest=? WHERE idempotency_key='activate-2'",
			).run(
				canonicalLifeJson(confirmation),
				canonicalLifeJson(receipt),
				receipt.inputDigest,
			);
		} finally {
			db.close();
		}
		expect(() => new WorldStore(f.path, f.clock)).toThrow(
			/activation autonomy migration/i,
		);
	} finally {
		f.close();
	}
});

test("an empty checkpoint does not allow a rehashed sidecar to change the migration source", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		acceptQuiet(f);
		const state = sidecar(f.path);
		state.variables["count"] = 6;
		const db = new DatabaseSync(f.path);
		try {
			db.prepare("UPDATE life_autonomy_state SET state_json=?,digest=?").run(
				canonicalLifeJson(state),
				lifeDigest(state),
			);
		} finally {
			db.close();
		}
		expect(() => proposePack(f.store, nextPack(f))).toThrow(
			/autonomy migration source history/i,
		);
		expect(f.store.snapshot(f.pack.worldId).revision).toBe(1);
	} finally {
		f.close();
	}
});
