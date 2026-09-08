import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LifeImageSettingsInput } from "../src/world/image-types.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { autonomyStoreFixture } from "./life-autonomy-store-fixture.ts";

export const imageSettings: LifeImageSettingsInput = {
	version: 1,
	worldVersion: null,
	route: { provider: "synthetic", model: "image" },
	eventRules: [],
	avatarEventRules: [],
	perAuthorCooldownSteps: 0,
	attachMode: "manual",
	maxJobsPerVisit: 1,
	storage: {
		maxActiveJobs: 4,
		maxArchivedJobs: 20,
		maxAssets: 10,
		maxTotalBytes: 32_000_000,
	},
};

function legacy() {
	const root = mkdtempSync(join(tmpdir(), "lina-image-settings-"));
	const path = join(root, "world.sqlite");
	const db = new DatabaseSync(path);
	try {
		// SQLite dumps order tables alphabetically. WorldStore audits the full graph after import.
		db.exec("PRAGMA foreign_keys=OFF");
		db.exec(
			readFileSync(new URL("./fixtures/life-v7.sql", import.meta.url), "utf8"),
		);
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	} finally {
		db.close();
	}
	return { path, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("schema7 migrates without image defaults and settings preserve choices/CAS through actual reopen", () => {
	const f = legacy();
	try {
		const old = new DatabaseSync(f.path);
		const before = old.prepare("SELECT * FROM life_commits").all();
		old.close();
		const store = new WorldStore(f.path);
		expect(store.imageSettings("test-world")).toBeNull();
		const saved = store.setImageSettings("test-world", 0, imageSettings);
		expect(saved.revision).toBe(1);
		expect(store.setImageSettings("test-world", 1, imageSettings)).toEqual(
			saved,
		);
		expect(() =>
			store.setImageSettings("test-world", 0, imageSettings),
		).toThrow(/revision/);
		store.close();
		const reopened = new WorldStore(f.path);
		try {
			expect(reopened.imageSettings("test-world")).toEqual(saved);
		} finally {
			reopened.close();
		}
		const db = new DatabaseSync(f.path);
		try {
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(8);
			expect(db.prepare("SELECT * FROM life_commits").all()).toEqual(before);
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

test("schema8 write failure leaves original schema7 and publication data intact", () => {
	const f = legacy(),
		original = DatabaseSync.prototype.exec;
	try {
		DatabaseSync.prototype.exec = function (sql: string) {
			if (/PRAGMA user_version\s*=\s*8/.test(sql))
				throw Error("image migration interrupted");
			return original.call(this, sql);
		};
		try {
			expect(() => new WorldStore(f.path).close()).toThrow(
				"image migration interrupted",
			);
		} finally {
			DatabaseSync.prototype.exec = original;
		}
		const db = new DatabaseSync(f.path);
		try {
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(7);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_schema WHERE name LIKE 'life_image_%'",
					)
					.all(),
			).toEqual([]);
			expect(
				db
					.prepare("SELECT count(*) AS n FROM life_publication_settings")
					.get()?.["n"],
			).toBe(1);
		} finally {
			db.close();
		}
		new WorldStore(f.path).close();
	} finally {
		DatabaseSync.prototype.exec = original;
		f.close();
	}
});

test.each(["missing", "digest", "unsafe_revision", "foreign_pack"] as const)(
	"image settings startup rejects %s corruption",
	(kind) => {
		const f = legacy();
		try {
			const store = new WorldStore(f.path);
			store.setImageSettings("test-world", 0, imageSettings);
			store.close();
			const db = new DatabaseSync(f.path);
			try {
				// Deliberate on-disk corruption bypasses SQLite foreign-key enforcement.
				db.exec("PRAGMA foreign_keys=OFF");
				if (kind === "missing") db.exec("DELETE FROM life_image_settings");
				if (kind === "digest")
					db.exec("UPDATE life_image_settings_history SET digest='bad'");
				if (kind === "unsafe_revision")
					db.exec(
						"UPDATE life_image_settings_history SET revision=9007199254740992",
					);
				if (kind === "foreign_pack") {
					const changed = { ...imageSettings, worldVersion: 99 };
					for (const table of [
						"life_image_settings",
						"life_image_settings_history",
					])
						db.prepare(`UPDATE ${table} SET settings_json=?,digest=?`).run(
							canonicalLifeJson(changed),
							lifeDigest(changed),
						);
				}
			} finally {
				db.close();
			}
			expect(() => new WorldStore(f.path).close()).toThrow();
		} finally {
			f.close();
		}
	},
);

test("image rules require real pack/family/participants and explicit global avatar permission", () => {
	const f = autonomyStoreFixture();
	try {
		expect(() =>
			f.store.setImageSettings("test-world", 0, imageSettings),
		).toThrow();
		const good = {
			...imageSettings,
			worldVersion: 1,
			avatarEventRules: [{ familyId: "meet", agentIds: ["lina"] }],
		};
		for (const changed of [
			{ ...good, worldVersion: 999 },
			{
				...good,
				avatarEventRules: [{ familyId: "missing", agentIds: ["lina"] }],
			},
			{
				...good,
				avatarEventRules: [{ familyId: "meet", agentIds: ["foreign"] }],
			},
			{ ...good, surprise: true },
			{ ...good, storage: { ...good.storage, maxAssets: -1 } },
		])
			expect(() =>
				f.store.setImageSettings("test-world", 0, changed),
			).toThrow();
		expect(
			f.store.setImageSettings("test-world", 0, good).avatarEventRules,
		).toEqual(good.avatarEventRules);
	} finally {
		f.close();
	}
});

test("corrupt schema7 publication owner is rejected before image DDL", () => {
	const f = legacy();
	try {
		const db = new DatabaseSync(f.path);
		db.exec("UPDATE life_publication_settings_history SET digest='corrupt'");
		expect(() => new WorldStore(f.path).close()).toThrow();
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(7);
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_schema WHERE name LIKE 'life_image_%'",
				)
				.all(),
		).toEqual([]);
		db.close();
	} finally {
		f.close();
	}
});
