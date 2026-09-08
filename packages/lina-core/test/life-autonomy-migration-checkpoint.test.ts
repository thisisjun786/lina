import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { createLifeRunner } from "../../lina-runtime/src/life/runner.ts";
import { runtimeStoreFixture } from "../../lina-runtime/test/life-runtime-store-fixture.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { literal, read, rule } from "./life-authoring-fixture.ts";
import { proposePack, sidecar } from "./life-autonomy-migration-fixture.ts";

async function initialized() {
	const f = runtimeStoreFixture(false, (pack) => {
		for (const policy of pack.autonomy.events) policy.cooldownSteps = 0;
		for (const family of pack.eventFamilies)
			family.condition = { op: "eq", left: read("count"), right: literal(7) };
		pack.rules = [
			rule("quiet-sets-seven", {
				effects: [{ kind: "assign", variableId: "count", value: literal(7) }],
			}),
		];
	});
	try {
		const first = await f.runner.run(
			"test-world",
			"quiet",
			1,
			new AbortController().signal,
		);
		expect(first.outcome?.kind).toBe("quiet");
		expect(first.outcome?.nextState.variables["count"]).toBe(7);
		const social = await f.runner.run(
			"test-world",
			"social",
			1,
			new AbortController().signal,
		);
		expect(social.outcome?.kind).toBe("activity");
		const pack = structuredClone(f.pack);
		pack.version++;
		pack.world.version++;
		pack.life.revision++;
		pack.variables.push({
			id: "new-variable",
			type: "number",
			initial: 9,
			min: 0,
			max: 10,
			knownTo: ["lina"],
		});
		pack.rules = [];
		return { f, pack };
	} catch (error) {
		await f.close();
		throw error;
	}
}

test("confirmed migration preserves native history and RNG while both variable copies retain accepted 7 and initialize 9", async () => {
	const { f, pack } = await initialized();
	try {
		const before = f.store.lifeSnapshot("test-world").checkpoint;
		if (before.engineId !== "ensemble")
			throw Error("Expected real native checkpoint");
		expect(before.data.variables["count"]).toBe(7);
		const p = proposePack(f.store, pack);
		expect(p.preview.evaluation?.variables["count"]).toBe(7);
		f.store.activateWorldDraft(p.confirmation);
		const after = f.store.lifeSnapshot("test-world").checkpoint;
		if (after.engineId !== "ensemble")
			throw Error("Missing migrated checkpoint");
		expect(after.data.variables).toEqual(sidecar(f.path).variables);
		expect(after.data.variables["count"]).toBe(7);
		expect(after.data.variables["new-variable"]).toBe(9);
		expect(after.data.rng).toEqual(before.data.rng);
		expect(after.data.state.history).toEqual(before.data.state.history);
		expect(after.data.state.step).toBe(before.data.state.step);
		expect(after.data.state.iterators["socialRecords"]).toBe(
			before.data.state.iterators["socialRecords"],
		);
		expect(after.data.state.iterators["actions"]).toBe(
			before.data.state.iterators["actions"],
		);
		expect(after.data.state.noRepeat).toEqual(before.data.state.noRepeat);
		expect(after.data.state.offstage).toEqual(before.data.state.offstage);
		expect(after.data.state.eliminated).toEqual(before.data.state.eliminated);
		// 030 rebuilds decision caches when the compiled variable schema changes.
		expect(after.data.state.cachePositions).toEqual({});
		expect(after.data.state.volitionCache).toEqual(["object", []]);
		expect(after.data.worldRevision).toBe(3);
		expect(after.data.lifeRevision).toBe(3);
		f.store.close();
		const reopened = new WorldStore(f.path, () => f.clock.now());
		try {
			expect(reopened.lifeSnapshot("test-world").checkpoint).toEqual(after);
			const runner = createLifeRunner({ ...f.options, store: reopened });
			try {
				const next = await runner.run(
					"test-world",
					"after-migration",
					1,
					new AbortController().signal,
				);
				expect(next.status).toBe("accepted");
				expect(next.outcome?.kind).toBe("activity");
				expect(next.source.autonomy.variables["count"]).toBe(7);
				expect(next.source.autonomy.variables["new-variable"]).toBe(9);
				const checkpoint = reopened.lifeSnapshot("test-world").checkpoint;
				if (checkpoint.engineId !== "ensemble")
					throw Error("Missing resumed checkpoint");
				expect(checkpoint.data.variables).toEqual(sidecar(f.path).variables);
				expect(checkpoint.data.state.step).toBe(2);
				expect(checkpoint.data.rng.drawIndex).toBeGreaterThan(
					before.data.rng.drawIndex,
				);
			} finally {
				await runner.close();
			}
		} finally {
			reopened.close();
		}
	} finally {
		await f.close();
	}
});

test("checkpoint and accepted sidecar disagreement rejects migration before the world event", async () => {
	const { f, pack } = await initialized();
	try {
		const forged = sidecar(f.path);
		forged.variables["count"] = 6;
		const db = new DatabaseSync(f.path);
		try {
			db.prepare("UPDATE life_autonomy_state SET state_json=?,digest=?").run(
				canonicalLifeJson(forged),
				lifeDigest(forged),
			);
		} finally {
			db.close();
		}
		expect(() => proposePack(f.store, pack)).toThrow(
			/autonom|variable|history/i,
		);
		expect(f.store.snapshot("test-world").revision).toBe(2);
		expect(() => f.store.worldPack("test-world", 2)).toThrow();
	} finally {
		await f.close();
	}
});
