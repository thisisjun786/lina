import { afterEach, expect, spyOn, test } from "bun:test";
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
import { stripPublicationFixture } from "./life-publication-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function v2() {
	const root = mkdtempSync(join(tmpdir(), "lina-author-migration-"));
	roots.push(root);
	const path = join(root, "world.sqlite");
	const store = new WorldStore(path);
	store.create(worldDefinition());
	store.prepareLife(lifeDefinition());
	store.acceptLife(socialCommit(), identityPolicy());
	store.close();
	// These empty tables are the entire v3 delta; the remaining schema/data are the historical v2 file.
	const raw = new DatabaseSync(path);
	stripPublicationFixture(raw);
	for (const table of [
		"life_work_ancestry",
		"life_work_experiences",
		"life_work_history",
		"life_work_state",
		"life_model_receipts",
		"life_steps",
		"life_autonomy_state",
		"life_schedules",
	])
		raw.exec(`DROP TABLE IF EXISTS ${table}`);
	for (const table of [
		"world_authoring_requests",
		"world_author_grants",
		"world_activations",
		"world_packs",
		"world_draft_versions",
		"world_drafts",
		"life_runtime_config",
	])
		raw.exec(`DROP TABLE ${table}`);
	raw.exec(
		"DROP TABLE world_social_resolutions; DROP TABLE world_social_bootstraps",
	);
	raw.exec("PRAGMA user_version = 2");
	const events = raw.prepare("SELECT event_json FROM world_events").all(),
		commits = raw.prepare("SELECT envelope_json FROM life_commits").all();
	raw.close();
	return { path, events, commits };
}
test("actual v2 file upgrades through v3 and v4 to v8 without rewriting accepted world/LIFE bytes", () => {
	const { path, events, commits } = v2();
	const store = new WorldStore(path);
	expect(store.lifeSnapshot("test-world").experiences).toHaveLength(2);
	store.close();
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 8,
		});
		expect(raw.prepare("SELECT event_json FROM world_events").all()).toEqual(
			events,
		);
		expect(raw.prepare("SELECT envelope_json FROM life_commits").all()).toEqual(
			commits,
		);
		expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		raw.close();
	}
});
test("corrupt v2 LIFE state is rejected before any v3 DDL", () => {
	const { path } = v2(),
		raw = new DatabaseSync(path);
	raw.exec("UPDATE life_config SET digest = 'corrupt'");
	raw.close();
	const exec = DatabaseSync.prototype.exec;
	let ddl = false;
	const fault = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			if (sql.includes("CREATE TABLE world_drafts")) ddl = true;
			return exec.call(this, sql);
		},
	);
	try {
		expect(() => {
			new WorldStore(path);
		}).toThrow();
		expect(ddl).toBe(false);
	} finally {
		fault.mockRestore();
	}
	const unchanged = new DatabaseSync(path);
	try {
		expect(unchanged.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 2,
		});
		expect(
			unchanged
				.prepare("SELECT name FROM sqlite_schema WHERE name = 'world_drafts'")
				.all(),
		).toEqual([]);
	} finally {
		unchanged.close();
	}
});
test("failure at v3 final version write rolls back all new DDL and preserves a reopenable v2 file", () => {
	const { path, commits } = v2(),
		exec = DatabaseSync.prototype.exec;
	const fault = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			if (/PRAGMA user_version\s*=\s*3/.test(sql))
				throw Error("synthetic v3 migration failure");
			return exec.call(this, sql);
		},
	);
	try {
		expect(() => {
			new WorldStore(path);
		}).toThrow("synthetic v3 migration failure");
	} finally {
		fault.mockRestore();
	}
	const raw = new DatabaseSync(path);
	try {
		expect(raw.prepare("PRAGMA user_version").get()).toEqual({
			user_version: 2,
		});
		expect(
			raw
				.prepare("SELECT name FROM sqlite_schema WHERE name = 'world_drafts'")
				.all(),
		).toEqual([]);
		expect(raw.prepare("SELECT envelope_json FROM life_commits").all()).toEqual(
			commits,
		);
	} finally {
		raw.close();
	}
	const recovered = new WorldStore(path);
	expect(recovered.lifeSnapshot("test-world").revision).toBe(1);
	recovered.close();
});
