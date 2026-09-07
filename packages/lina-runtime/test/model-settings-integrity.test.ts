import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelSettingsStore } from "../src/models/settings.ts";
import type { ModelSettingsInput } from "../src/models/types.ts";

function input(): ModelSettingsInput {
	return {
		profiles: [
			{
				id: "test",
				provider: "native",
				model: "synthetic-model",
				reasoning: "medium",
				maxOutputTokens: 512,
			},
		],
		defaultProfileId: "test",
		roles: {},
		agentRoles: {},
	};
}

describe("model settings persisted integrity", () => {
	let root: string;
	let path: string;
	const opened: ModelSettingsStore[] = [];
	function open(): ModelSettingsStore {
		const store = new ModelSettingsStore(path);
		opened.push(store);
		return store;
	}
	function edit(operation: (db: DatabaseSync) => void): void {
		const db = new DatabaseSync(path);
		try {
			operation(db);
		} finally {
			db.close();
		}
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lina-model-integrity-"));
		path = join(root, "models.sqlite");
	});
	afterEach(() => {
		for (const store of opened.splice(0)) store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it.each([
		"PRAGMA user_version = 2",
		"ALTER TABLE model_settings ADD COLUMN extra TEXT",
		"CREATE TABLE foreign_data (id INTEGER)",
		"CREATE TRIGGER extra_trigger BEFORE UPDATE ON model_settings BEGIN SELECT RAISE(ABORT, 'unexpected'); END",
		"DELETE FROM model_settings",
		"PRAGMA ignore_check_constraints = ON; UPDATE model_settings SET revision = -1",
	])(
		"refuses unknown/corrupt persisted schema or rows without migrating: %s",
		(sql) => {
			const store = open();
			store.replace(0, input());
			store.close();
			edit((db) => db.exec(sql));
			const before = readFileSync(path);
			expect(() => open()).toThrow();
			expect(readFileSync(path)).toEqual(before);
			// A failed constructor releases its transaction and connection.
			edit((db) => db.exec("BEGIN IMMEDIATE; ROLLBACK"));
		},
	);

	const invalidJson: [string, () => string][] = [
		["malformed JSON", () => "{"],
		[
			"unknown settings field",
			() => JSON.stringify({ ...input(), revision: 100 }),
		],
		[
			"unknown enum",
			() =>
				JSON.stringify({
					...input(),
					profiles: [{ ...input().profiles[0], reasoning: "unknown" }],
				}),
		],
		[
			"credential field",
			() =>
				JSON.stringify({
					...input(),
					profiles: [{ ...input().profiles[0], apiKey: "synthetic-only" }],
				}),
		],
		[
			"unknown default",
			() => JSON.stringify({ ...input(), defaultProfileId: "missing" }),
		],
		[
			"unknown global reference",
			() => JSON.stringify({ ...input(), roles: { summary: "missing" } }),
		],
		[
			"unknown agent reference",
			() =>
				JSON.stringify({
					...input(),
					agentRoles: { lina: { recall: "missing" } },
				}),
		],
		[
			"unsafe agent ID",
			() => JSON.stringify({ ...input(), agentRoles: { "../lina": {} } }),
		],
		[
			"invalid budget",
			() =>
				JSON.stringify({
					...input(),
					profiles: [{ ...input().profiles[0], maxOutputTokens: 0 }],
				}),
		],
		[
			"duplicate profiles",
			() =>
				JSON.stringify({
					...input(),
					profiles: [input().profiles[0], input().profiles[0]],
				}),
		],
	];
	it.each(invalidJson)(
		"validates %s on reopen without rewriting it",
		(_label, payload) => {
			const store = open();
			store.replace(0, input());
			store.close();
			edit((db) =>
				db
					.prepare("UPDATE model_settings SET settings_json = ?")
					.run(payload()),
			);
			const before = readFileSync(path);
			expect(() => open()).toThrow();
			expect(readFileSync(path)).toEqual(before);
			edit((db) =>
				db
					.prepare("UPDATE model_settings SET settings_json = ?")
					.run(JSON.stringify(input())),
			);
			expect(open().snapshot()).toEqual({ revision: 1, ...input() });
		},
	);

	it.each(["CREATE TABLE unrelated (id INTEGER)", "PRAGMA user_version = 0"])(
		"does not repurpose an existing foreign SQLite file: %s",
		(sql) => {
			edit((db) => db.exec(sql));
			const before = readFileSync(path);
			expect(() => open()).toThrow(/schema/i);
			expect(readFileSync(path)).toEqual(before);
		},
	);

	it("revalidates persisted JSON before replacement and does not hide corruption", () => {
		const store = open();
		edit((db) =>
			db
				.prepare("UPDATE model_settings SET settings_json = ?")
				.run('{"profiles":[]}'),
		);
		expect(() => store.snapshot()).toThrow();
		expect(() => store.replace(0, input())).toThrow();
		edit((db) =>
			expect(
				db.prepare("SELECT revision, settings_json FROM model_settings").get(),
			).toEqual({ revision: 0, settings_json: '{"profiles":[]}' }),
		);
	});

	it("revalidates schema before writes even on an already open connection", () => {
		const store = open();
		edit((db) => db.exec("PRAGMA user_version = 2"));
		expect(() => store.replace(0, input())).toThrow(/schema/i);
		edit((db) =>
			expect(
				db.prepare("SELECT revision FROM model_settings").get()?.["revision"],
			).toBe(0),
		);
	});

	it("does not wrap or round an exhausted revision", () => {
		const store = open();
		edit((db) =>
			db
				.prepare("UPDATE model_settings SET revision = ?")
				.run(Number.MAX_SAFE_INTEGER),
		);
		expect(() => store.replace(Number.MAX_SAFE_INTEGER, input())).toThrow(
			/revision/i,
		);
		expect(store.snapshot().revision).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("a locked database fails without a partial write and remains usable after unlock", () => {
		const store = open();
		const blocker = new DatabaseSync(path);
		try {
			blocker.exec("BEGIN IMMEDIATE");
			expect(() => store.replace(0, input())).toThrow(/locked|busy/i);
			expect(store.snapshot().revision).toBe(0);
		} finally {
			blocker.exec("ROLLBACK");
			blocker.close();
		}
		expect(store.replace(0, input())).toEqual({ revision: 1, ...input() });
	});

	it.each([1, 1_048_576])(
		"accepts the bounded output budget %s and fleet ID limit",
		(maxOutputTokens) => {
			const store = open();
			const candidate = input();
			const first = candidate.profiles[0];
			if (!first) throw new Error("missing fixture profile");
			first.maxOutputTokens = maxOutputTokens;
			candidate.agentRoles["a".repeat(48)] = { conversation: "test" };
			candidate.agentRoles["constructor"] = { recall: "test" };
			expect(store.replace(0, candidate)).toEqual({
				revision: 1,
				...candidate,
			});
		},
	);
});
