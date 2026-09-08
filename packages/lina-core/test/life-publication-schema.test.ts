import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../src/world/store.ts";

function legacy() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-schema-"));
	const path = join(root, "world.sqlite");
	const db = new DatabaseSync(path);
	try {
		// The independent SQLite dump orders tables alphabetically; audit the complete graph after import.
		db.exec("PRAGMA foreign_keys=OFF");
		db.exec(
			readFileSync(new URL("./fixtures/life-v6.sql", import.meta.url), "utf8"),
		);
		const steps = db.prepare("SELECT * FROM life_steps").all();
		const commits = db.prepare("SELECT * FROM life_commits").all();
		return {
			path,
			steps,
			commits,
			close: () => rmSync(root, { recursive: true, force: true }),
		};
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	} finally {
		db.close();
	}
}
const settings = {
	version: 1 as const,
	agentRecipients: [{ agentId: "lina", recipientId: "friends" }],
	reactionIds: ["wave"],
	maxChainDepth: 4,
	maxActionsPerChain: 12,
	perAuthorCooldownSteps: 1,
	maxJobsPerRun: 2,
};

test("real v6 file upgrades without inventing publication settings or changing accepted history", () => {
	const f = legacy();
	try {
		const store = new WorldStore(f.path, () => 1000);
		try {
			expect(store.publicationSettings("test-world")).toBeNull();
		} finally {
			store.close();
		}
		const db = new DatabaseSync(f.path);
		try {
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(8);
			expect(db.prepare("SELECT * FROM life_steps").all()).toEqual(f.steps);
			expect(db.prepare("SELECT * FROM life_commits").all()).toEqual(f.commits);
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

test("publication settings use CAS, preserve explicit choices on reopen and reject foreign agents", () => {
	const f = legacy();
	try {
		const store = new WorldStore(f.path, () => 1000);
		try {
			expect(store.setPublicationSettings("test-world", 0, settings)).toEqual({
				...settings,
				worldId: "test-world",
				revision: 1,
			});
			expect(() =>
				store.setPublicationSettings("test-world", 0, settings),
			).toThrow();
			expect(() =>
				store.setPublicationSettings("test-world", 1, {
					...settings,
					agentRecipients: [{ agentId: "foreign", recipientId: "friends" }],
				}),
			).toThrow();
			expect(
				store.setPublicationSettings("test-world", 1, {
					...settings,
					reactionIds: [],
					maxJobsPerRun: 0,
				}).revision,
			).toBe(2);
		} finally {
			store.close();
		}
		const reopened = new WorldStore(f.path, () => 1000);
		try {
			expect(reopened.publicationSettings("test-world")).toEqual({
				...settings,
				worldId: "test-world",
				revision: 2,
				reactionIds: [],
				maxJobsPerRun: 0,
			});
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("failure at the schema7 version write rolls back to the exact reopenable v6 database", () => {
	const f = legacy(),
		original = DatabaseSync.prototype.exec;
	try {
		DatabaseSync.prototype.exec = function (sql: string) {
			if (/PRAGMA user_version\s*=\s*7/.test(sql))
				throw Error("synthetic publication migration failure");
			return original.call(this, sql);
		};
		try {
			expect(() => new WorldStore(f.path, () => 1000).close()).toThrow(
				"synthetic publication migration failure",
			);
		} finally {
			DatabaseSync.prototype.exec = original;
		}
		const db = new DatabaseSync(f.path);
		try {
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(6);
			expect(
				db
					.prepare(
						"SELECT name FROM sqlite_schema WHERE name LIKE 'life_publication_%'",
					)
					.all(),
			).toEqual([]);
			expect(db.prepare("SELECT * FROM life_steps").all()).toEqual(f.steps);
		} finally {
			db.close();
		}
		new WorldStore(f.path, () => 1000).close();
	} finally {
		DatabaseSync.prototype.exec = original;
		f.close();
	}
});

test("missing or inconsistent settings history fails actual file reopen", () => {
	for (const mutation of [
		"DELETE FROM life_publication_settings",
		"UPDATE life_publication_settings_history SET digest='bad'",
	]) {
		const f = legacy();
		try {
			const store = new WorldStore(f.path, () => 1000);
			try {
				store.setPublicationSettings("test-world", 0, settings);
			} finally {
				store.close();
			}
			const db = new DatabaseSync(f.path);
			try {
				db.exec(mutation);
			} finally {
				db.close();
			}
			expect(() => new WorldStore(f.path, () => 1000).close()).toThrow();
		} finally {
			f.close();
		}
	}
});
