import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/store.ts";
import {
	identityPolicy,
	lifeDefinition,
	socialCommit,
} from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function v4() {
	const root = mkdtempSync(join(tmpdir(), "lina-autonomy-schema-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path);
	try {
		store.create(worldDefinition());
		store.prepareLife(lifeDefinition());
		store.acceptLife(socialCommit(), identityPolicy());
	} finally {
		store.close();
	}
	const raw = new DatabaseSync(path);
	raw.exec(
		"DROP TABLE IF EXISTS life_model_receipts; DROP TABLE IF EXISTS life_steps; DROP TABLE IF EXISTS life_autonomy_state; DROP TABLE IF EXISTS life_schedules; PRAGMA user_version = 4",
	);
	const snapshot = raw.prepare("SELECT * FROM life_states").all();
	raw.close();
	return { path, snapshot };
}

test("an actual v4 file migrates to v5 without rewriting historical LIFE bytes", () => {
	const { path, snapshot } = v4();
	const store = new WorldStore(path);
	try {
		expect(store.lifeSnapshot("test-world").revision).toBe(1);
	} finally {
		store.close();
	}
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 5,
		});
		expect(raw.prepare("SELECT * FROM life_states").all()).toEqual(snapshot);
		expect(
			raw
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name IN ('life_autonomy_state', 'life_model_receipts', 'life_schedules', 'life_steps') ORDER BY name",
				)
				.all(),
		).toEqual([
			{ name: "life_autonomy_state" },
			{ name: "life_model_receipts" },
			{ name: "life_schedules" },
			{ name: "life_steps" },
		]);
	} finally {
		raw.close();
	}
});

test("the final v5 pragma failing rolls back every new sidecar", () => {
	const { path, snapshot } = v4();
	const original = DatabaseSync.prototype.exec;
	DatabaseSync.prototype.exec = function (sql: string) {
		if (/PRAGMA user_version\s*=\s*5/.test(sql))
			throw Error("synthetic migration fault");
		return original.call(this, sql);
	};
	try {
		expect(() => {
			new WorldStore(path).close();
		}).toThrow("synthetic migration fault");
	} finally {
		DatabaseSync.prototype.exec = original;
	}
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 4,
		});
		expect(raw.prepare("SELECT * FROM life_states").all()).toEqual(snapshot);
		expect(
			raw
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name IN ('life_autonomy_state', 'life_model_receipts', 'life_schedules', 'life_steps')",
				)
				.all(),
		).toEqual([]);
	} finally {
		raw.close();
	}
});

test("corrupt v4 data is rejected before autonomy DDL", () => {
	const { path } = v4();
	const raw = new DatabaseSync(path);
	raw.exec("UPDATE life_states SET life_revision = 9007199254740992");
	raw.close();
	expect(() => {
		new WorldStore(path).close();
	}).toThrow();
	const inspect = new DatabaseSync(path);
	try {
		expect(inspect.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 4,
		});
		expect(
			inspect
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name IN ('life_autonomy_state', 'life_model_receipts', 'life_schedules', 'life_steps')",
				)
				.all(),
		).toEqual([]);
	} finally {
		inspect.close();
	}
});
