import { afterEach, expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";
import { workInput } from "./life-work-fixture.ts";

const close: Array<() => void> = [];
afterEach(() => {
	for (const fn of close.splice(0).reverse()) fn();
});
function v5() {
	const f = autonomyStoreFixture();
	close.push(() => f.close());
	const step = f.store.prepareLifeStep(f.request, () => 1);
	f.store.finishLifeStep(step.lease, step.id, f.clock());
	f.store.acceptLifeStep(
		step.lease,
		step.id,
		{ identity: f.request.identity, modelSettingsRevision: 1 },
		f.clock(),
	);
	f.store.close();
	const raw = new DatabaseSync(f.path);
	// Empty work metadata is the complete v6 step delta; the v5 quiet outcome and receipt are identical.
	const row = raw.prepare("SELECT step_json FROM life_steps").get();
	if (!row) throw Error("Missing fixture");
	const legacy = JSON.parse(String(row["step_json"]));
	legacy.version = 1;
	delete legacy.source.work;
	delete legacy.source.workAncestry;
	raw
		.prepare("UPDATE life_steps SET step_json=?,digest=?")
		.run(canonicalLifeJson(legacy), lifeDigest(legacy));
	for (const table of [
		"life_work_ancestry",
		"life_work_experiences",
		"life_work_history",
		"life_work_state",
	])
		raw.exec(`DROP TABLE ${table}`);
	raw.exec("PRAGMA user_version=5");
	const steps = raw.prepare("SELECT * FROM life_steps").all(),
		commits = raw.prepare("SELECT * FROM life_commits").all();
	raw.close();
	return { ...f, steps, commits };
}
test("actual v5 file with a historical accepted step upgrades without rewriting its source, outcome or receipt", () => {
	const f = v5();
	const store = new WorldStore(f.path, f.clock);
	close.push(() => store.close());
	expect(store.lifeSnapshot(f.request.worldId).revision).toBe(1);
	expect(store.workEvidence(f.request.worldId).records).toEqual([]);
	store.close();
	const raw = new DatabaseSync(f.path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 6,
		});
		expect(raw.prepare("SELECT * FROM life_steps").all()).toEqual(f.steps);
		expect(raw.prepare("SELECT * FROM life_commits").all()).toEqual(f.commits);
	} finally {
		raw.close();
	}
});
test("failure at final v6 pragma rolls all work DDL back to the reopenable v5 source", () => {
	const f = v5(),
		original = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (sql: string) {
		if (/PRAGMA user_version\s*=\s*6/.test(sql))
			throw Error("synthetic v6 fault");
		return original.call(this, sql);
	};
	try {
		expect(() => new WorldStore(f.path, f.clock).close()).toThrow(
			"synthetic v6 fault",
		);
	} finally {
		DatabaseSync.prototype.exec = original;
	}
	const raw = new DatabaseSync(f.path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 5,
		});
		expect(
			raw
				.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'life_work_%'")
				.all(),
		).toEqual([]);
		expect(raw.prepare("SELECT * FROM life_steps").all()).toEqual(f.steps);
	} finally {
		raw.close();
	}
	const reopened = new WorldStore(f.path, f.clock);
	close.push(() => reopened.close());
	expect(reopened.lifeSnapshot(f.request.worldId).revision).toBe(1);
});

for (const mutation of [
	"UPDATE life_work_state SET digest='corrupt'",
	"UPDATE life_work_history SET revision=9007199254740992 WHERE revision=(SELECT MAX(revision) FROM life_work_history)",
	"DELETE FROM life_work_ancestry",
	"UPDATE life_work_experiences SET agent_id='changed-owner'",
] as const)
	test(`startup refuses corrupt work projections: ${mutation}`, () => {
		const f = autonomyStoreFixture();
		close.push(() => f.close());
		const worldId = f.request.worldId;
		const {
			worldId: _world,
			revision,
			...config
		} = f.store.lifeConfig(worldId);
		f.store.setLifeConfig(worldId, revision, {
			...config,
			version: 2,
			work: {
				rules: [
					{
						id: "rule",
						familyId: "meet",
						categoryId: "research",
						outcomes: [],
						attribution: "owner",
						weight: 1,
						requiredMatch: false,
					},
				],
			},
		});
		f.store.admitWorkInput(workInput(worldId));
		const step = f.store.prepareLifeStep(
			{ ...f.request, expectedConfigRevision: 2 },
			() => 1,
		);
		f.store.finishLifeStep(step.lease, step.id, f.clock());
		f.store.acceptLifeStep(
			step.lease,
			step.id,
			{ identity: f.request.identity, modelSettingsRevision: 1 },
			f.clock(),
		);
		f.store.close();
		const raw = new DatabaseSync(f.path);
		raw.exec(mutation);
		const history = raw.prepare("SELECT * FROM life_commits").all();
		raw.close();
		expect(() => new WorldStore(f.path, f.clock).close()).toThrow();
		const after = new DatabaseSync(f.path);
		try {
			expect(after.prepare("SELECT * FROM life_commits").all()).toEqual(
				history,
			);
		} finally {
			after.close();
		}
	});
