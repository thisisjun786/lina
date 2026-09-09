import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import {
	acceptQuiet,
	activateBaseline,
	migrationFixture,
	nextPack,
	proposePack,
	sidecar,
} from "./life-autonomy-migration-fixture.ts";

test("v3 activation previews are versioned before autonomy initialization and reopen after a quiet step", () => {
	const f = migrationFixture();
	try {
		const baseline = activateBaseline(f);
		expect(baseline.version).toBe(3);
		expect(baseline.preview).toMatchObject({
			version: 3,
			socialMigration: null,
			autonomyMigration: null,
		});
		acceptQuiet(f);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeSnapshot(f.pack.worldId).revision).toBe(1);
			expect(sidecar(f.path).variables["count"]).toBe(7);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});
test("confirmed migration preserves accepted 7 initializes only additions and replays both definition envelope and steps", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		const step = acceptQuiet(f),
			before = sidecar(f.path),
			pack = nextPack(f),
			proposal = proposePack(f.store, pack);
		expect(proposal.preview.version).toBe(3);
		expect(proposal.preview).toMatchObject({
			autonomyMigration: {
				fromPackVersion: 1,
				toPackVersion: 2,
				worldRevision: 2,
				lifeRevision: 2,
				previousStateDigest: lifeDigest(before),
			},
		});
		const receipt = f.store.activateWorldDraft(proposal.confirmation),
			after = sidecar(f.path);
		expect(receipt.version).toBe(3);
		expect(after).toMatchObject({
			worldRevision: 2,
			lifeRevision: 2,
			packVersion: 2,
			stepNumber: 1,
			seed: 42,
			selectionIndex: 0,
			variables: { count: 7, "new-variable": 9 },
		});
		expect(
			after.needs
				.filter((n: { needId: string }) => n.needId === "new-need")
				.map((n: { value: number }) => n.value),
		).toEqual([9, 9, 9]);
		const db = new DatabaseSync(f.path);
		try {
			const row = db
				.prepare("SELECT envelope_json FROM life_commits WHERE life_revision=2")
				.get() as { envelope_json: string };
			expect(JSON.parse(row.envelope_json)).toMatchObject({
				version: 4,
				kind: "definition",
				autonomyMigration: { nextStateDigest: lifeDigest(after) },
			});
		} finally {
			db.close();
		}
		expect(f.store.activateWorldDraft(proposal.confirmation).replayed).toBe(
			true,
		);
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		try {
			expect(reopened.lifeSnapshot(f.pack.worldId).revision).toBe(2);
			expect(reopened.lifeStep(f.pack.worldId, step.id).outcome).toEqual(
				step.outcome,
			);
			expect(sidecar(f.path)).toEqual(after);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});
test("active autonomy rejects downgrade and preview tampering without writes", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		acceptQuiet(f);
		const before = sidecar(f.path),
			pack = nextPack(f);
		const { autonomy: _, ...rest } = pack;
		expect(() => proposePack(f.store, { ...rest, schemaVersion: 2 })).toThrow(
			/autonom|downgrade/i,
		);
		const p = proposePack(f.store, pack);
		expect(() =>
			f.store.activateWorldDraft({
				...p.confirmation,
				previewDigest: "0".repeat(64),
			}),
		).toThrow(/preview/i);
		expect(sidecar(f.path)).toEqual(before);
		expect(f.store.snapshot(f.pack.worldId).revision).toBe(1);
	} finally {
		f.close();
	}
});
test("post-state-write activation failure rolls back sidecar ledger and immutable pack registration", () => {
	const f = migrationFixture();
	try {
		activateBaseline(f);
		acceptQuiet(f);
		const before = sidecar(f.path),
			p = proposePack(f.store, nextPack(f));
		const raw = new DatabaseSync(f.path);
		raw.exec(
			"CREATE TRIGGER fail_activation BEFORE INSERT ON world_activations WHEN NEW.idempotency_key='activate-2' BEGIN SELECT RAISE(ABORT,'synthetic activation failure'); END",
		);
		raw.close();
		expect(() => f.store.activateWorldDraft(p.confirmation)).toThrow(
			/synthetic/,
		);
		expect(sidecar(f.path)).toEqual(before);
		expect(f.store.lifeSnapshot(f.pack.worldId).revision).toBe(1);
		expect(() => f.store.worldPack(f.pack.worldId, 2)).toThrow();
		const cleanup = new DatabaseSync(f.path);
		cleanup.exec("DROP TRIGGER fail_activation");
		cleanup.close();
		f.store.close();
		const reopened = new WorldStore(f.path, f.clock);
		reopened.close();
	} finally {
		f.close();
	}
});
