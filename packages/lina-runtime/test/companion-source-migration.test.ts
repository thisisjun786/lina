import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	ordinarySource,
	restrictSource,
} from "../../lina-memory/test/fixtures/native-sources.ts";
import { CompanionQueue } from "../src/context/companion-queue.ts";
import { companionV3 } from "./helpers/companion-v3.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

test("exact v3 migration withholds every legacy state and retains attempts, errors and history", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "old.queue");
	companionV3(path, f.runtime.binding);
	const lookup = (id: string) =>
		ordinarySource({ entryId: id, role: "user", text: id });
	let q = new CompanionQueue(path, f.runtime.binding, { lookup });
	try {
		expect(q.pending()).toEqual([]);
		expect(q.counts()).toMatchObject({ withheld: 4, accepted: 0, failed: 0 });
		let db = new DatabaseSync(path);
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(4);
		expect(
			db
				.prepare(
					"SELECT count(*) n FROM companion_jobs WHERE state='withheld' AND attempts=2 AND error='old_error'",
				)
				.get()?.["n"],
		).toBe(4);
		expect(
			db
				.prepare(
					"SELECT count(*) n FROM companion_history WHERE error='old_error'",
				)
				.get()?.["n"],
		).toBe(4);
		db.close();
		q.add("ordinary", ["ordinary"], 5);
		expect(q.start("ordinary")).toBe(true);
		q.finish("ordinary", true);
		q.close();
		q = new CompanionQueue(path, f.runtime.binding, { lookup });
		expect(q.counts()).toMatchObject({ withheld: 4, accepted: 1 });
		db = new DatabaseSync(path);
		expect(
			db.prepare("SELECT cursor FROM companion_meta").get()?.["cursor"],
		).toBe(5);
		db.close();
	} finally {
		q.close();
		await f.close();
	}
});
test("done and failed jobs recheck exact policy revision even without restarting", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "jobs.queue");
	const entry = ordinarySource({ entryId: "u", role: "user", text: "tea" });
	const q = new CompanionQueue(path, f.runtime.binding, {
		lookup: () => entry,
	});
	try {
		q.add("u", ["u"], 1);
		q.start("u");
		q.finish("u", true);
		restrictSource(entry);
		q.reconcileReceipts(() => true);
		expect(q.counts()).toMatchObject({ withheld: 1, accepted: 0 });
		expect(q.recover(["u"], "try-again")).toBe(0);
	} finally {
		q.close();
		await f.close();
	}
});
test("unknown final queue DDL rolls the migration back to the exact old version and rows", async () => {
	const f = createRuntimeFixture(),
		path = join(f.root, "rollback.queue");
	companionV3(path, f.runtime.binding);
	const original = DatabaseSync.prototype.exec;
	const patch = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
		function (this: DatabaseSync, sql: string) {
			original.call(this, sql);
			if (sql.includes("PRAGMA user_version=4;"))
				original.call(
					this,
					"CREATE TABLE migration_corruption (x TEXT) STRICT",
				);
		},
	);
	try {
		expect(() => new CompanionQueue(path, f.runtime.binding)).toThrow(/schema/);
	} finally {
		patch.mockRestore();
	}
	const db = new DatabaseSync(path);
	try {
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(3);
		expect(
			db
				.prepare(
					"SELECT count(*) n FROM companion_jobs WHERE attempts=2 AND state!='withheld'",
				)
				.get()?.["n"],
		).toBe(4);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name='migration_corruption'",
				)
				.get(),
		).toBeUndefined();
	} finally {
		db.close();
		await f.close();
	}
});
