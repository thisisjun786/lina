import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	defaultEnginePolicy,
	type EnginePolicyInput,
	EnginePolicySettingsStore,
} from "../src/context/policy-settings.ts";

function input(
	memory: Partial<EnginePolicyInput["memory"]> = {},
): EnginePolicyInput {
	return {
		version: 1,
		memory: {
			enabled: true,
			maxSearchRounds: 2,
			maxVisits: 40,
			inputChars: 4096,
			maxOutputTokens: 2048,
			maxAttempts: 2,
			...memory,
		},
	};
}

const DEFAULT_MEMORY = {
	enabled: true,
	maxSearchRounds: 1,
	maxVisits: 32,
	inputChars: 22000,
	maxOutputTokens: 1024,
	maxAttempts: 3,
};

describe("engine policy settings", () => {
	let root: string;
	let path: string;
	const opened: EnginePolicySettingsStore[] = [];
	function open(): EnginePolicySettingsStore {
		const store = new EnginePolicySettingsStore(path);
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
		root = mkdtempSync(join(tmpdir(), "lina-engine-policy-"));
		path = join(root, "policy.sqlite");
	});
	afterEach(() => {
		for (const store of opened.splice(0)) store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("returns an immutable revision-0 default without creating a database", () => {
		expect(existsSync(path)).toBe(false);
		const first = defaultEnginePolicy();
		expect(first).toEqual({
			version: 1,
			revision: 0,
			memory: DEFAULT_MEMORY,
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.memory)).toBe(true);
		expect(() => {
			(first as { revision: number }).revision = 9;
		}).toThrow();
		expect(() => {
			(first.memory as { enabled: boolean }).enabled = false;
		}).toThrow();
		const second = defaultEnginePolicy();
		expect(second).toEqual(first);
		expect(second).not.toBe(first);
		expect(second.memory).not.toBe(first.memory);
		expect(existsSync(path)).toBe(false);
		expect(existsSync(root)).toBe(true);
	});

	it("creates a file database only from the store constructor and starts at the default", () => {
		expect(existsSync(path)).toBe(false);
		const store = open();
		expect(existsSync(path)).toBe(true);
		expect(store.snapshot()).toEqual(defaultEnginePolicy());
		expect(readFileSync(path).subarray(0, 16).toString()).toBe(
			"SQLite format 3\u0000",
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("persists a complete replacement through reopen", () => {
		const store = open();
		expect(store.replace(0, input())).toEqual({ revision: 1, ...input() });
		store.close();
		const reopened = open();
		expect(reopened.snapshot()).toEqual({ revision: 1, ...input() });
		expect(reopened.replace(1, input({ enabled: false }))).toEqual({
			revision: 2,
			...input({ enabled: false }),
		});
		reopened.close();
		expect(open().snapshot()).toEqual({
			revision: 2,
			...input({ enabled: false }),
		});
	});

	it("rejects stale writes across independent connections without losing the winner", () => {
		const first = open();
		const second = open();
		expect(first.snapshot().revision).toBe(0);
		expect(second.snapshot().revision).toBe(0);
		expect(first.replace(0, input()).revision).toBe(1);
		expect(() => second.replace(0, input({ maxSearchRounds: 4 }))).toThrow(
			/stale.*revision/i,
		);
		expect(second.snapshot()).toEqual({ revision: 1, ...input() });
		expect(second.replace(1, input({ maxSearchRounds: 4 })).revision).toBe(2);
		expect(first.snapshot().memory.maxSearchRounds).toBe(4);
	});

	it("detaches input, replace return and snapshots", () => {
		const store = open();
		const supplied = input();
		const saved = store.replace(0, supplied);
		supplied.memory.maxVisits = 1;
		saved.memory.maxVisits = 1;
		saved.revision = 99;
		const snapshot = store.snapshot();
		snapshot.memory.inputChars = 1024;
		snapshot.revision = 0;
		expect(store.snapshot()).toEqual({ revision: 1, ...input() });
	});

	it("closes idempotently and rejects further operations", () => {
		const store = open();
		store.close();
		expect(() => store.close()).not.toThrow();
		expect(() => store.snapshot()).toThrow(/closed/i);
		expect(() => store.replace(0, input())).toThrow(/closed/i);
	});

	it.each([
		["revision in public input", () => ({ ...input(), revision: 100 })],
		["unknown top-level field", () => ({ ...input(), endpoints: [] })],
		[
			"unknown memory field",
			() => ({ ...input(), memory: { ...input().memory, extra: 1 } }),
		],
		["unknown version", () => ({ ...input(), version: 2 })],
		["missing memory", () => ({ version: 1 })],
		["array input", () => []],
		["null input", () => null],
		["enabled number", () => input({ enabled: 1 as unknown as boolean })],
		[
			"string rounds",
			() => input({ maxSearchRounds: "1" as unknown as number }),
		],
		["negative rounds", () => input({ maxSearchRounds: -1 })],
		["rounds above bound", () => input({ maxSearchRounds: 9 })],
		["fractional rounds", () => input({ maxSearchRounds: 1.5 })],
		["zero visits", () => input({ maxVisits: 0 })],
		["visits above bound", () => input({ maxVisits: 201 })],
		["inputChars below bound", () => input({ inputChars: 1023 })],
		["inputChars above bound", () => input({ inputChars: 32001 })],
		["zero output tokens", () => input({ maxOutputTokens: 0 })],
		["output tokens above bound", () => input({ maxOutputTokens: 1_048_577 })],
		[
			"unsafe output tokens",
			() => input({ maxOutputTokens: Number.MAX_SAFE_INTEGER }),
		],
		["zero attempts", () => input({ maxAttempts: 0 })],
		["attempts above bound", () => input({ maxAttempts: 4 })],
		["NaN visits", () => input({ maxVisits: Number.NaN })],
		[
			"infinite inputChars",
			() => input({ inputChars: Number.POSITIVE_INFINITY }),
		],
	])("rejects %s before mutation", (_label, candidate) => {
		const store = open();
		const saved = store.replace(0, input());
		expect(() => store.replace(1, candidate() as EnginePolicyInput)).toThrow();
		expect(store.snapshot()).toEqual(saved);
		store.close();
		expect(open().snapshot()).toEqual(saved);
	});

	it.each([
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	])("rejects invalid expected revision %s", (revision) => {
		const store = open();
		expect(() => store.replace(revision, input())).toThrow(/revision/i);
		expect(store.snapshot().revision).toBe(0);
	});

	it.each([
		["disabled memory", { enabled: false }],
		["zero extra search rounds", { maxSearchRounds: 0 }],
		["maximum search rounds", { maxSearchRounds: 8 }],
		["minimum visits", { maxVisits: 1 }],
		["maximum visits", { maxVisits: 200 }],
		["minimum input chars", { inputChars: 1024 }],
		["maximum input chars", { inputChars: 32000 }],
		["minimum output tokens", { maxOutputTokens: 1 }],
		["maximum output tokens", { maxOutputTokens: 1_048_576 }],
		["minimum attempts", { maxAttempts: 1 }],
		["maximum attempts", { maxAttempts: 3 }],
	] as const)("accepts bounded policy %s", (_label, memory) => {
		const store = open();
		expect(store.replace(0, input(memory))).toEqual({
			revision: 1,
			...input(memory),
		});
	});

	it.each([
		"PRAGMA user_version = 2",
		"ALTER TABLE engine_policy_settings ADD COLUMN extra TEXT",
		"CREATE TABLE foreign_data (id INTEGER)",
		"CREATE TRIGGER extra_trigger BEFORE UPDATE ON engine_policy_settings BEGIN SELECT RAISE(ABORT, 'unexpected'); END",
		"DELETE FROM engine_policy_settings",
		"PRAGMA ignore_check_constraints = ON; UPDATE engine_policy_settings SET revision = -1",
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
			edit((db) => db.exec("BEGIN IMMEDIATE; ROLLBACK"));
		},
	);

	const invalidJson: [string, () => string][] = [
		["malformed JSON", () => "{"],
		[
			"unknown settings field",
			() => JSON.stringify({ ...input(), revision: 100 }),
		],
		["unknown version", () => JSON.stringify({ ...input(), version: 2 })],
		[
			"unknown memory field",
			() =>
				JSON.stringify({
					...input(),
					memory: { ...input().memory, extra: true },
				}),
		],
		[
			"non-safe integer",
			() =>
				JSON.stringify({
					...input(),
					memory: { ...input().memory, maxVisits: 1.5 },
				}),
		],
		[
			"unsafe integer",
			() =>
				JSON.stringify({
					...input(),
					memory: {
						...input().memory,
						maxOutputTokens: Number.MAX_SAFE_INTEGER + 1,
					},
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
					.prepare("UPDATE engine_policy_settings SET settings_json = ?")
					.run(payload()),
			);
			const before = readFileSync(path);
			expect(() => open()).toThrow();
			expect(readFileSync(path)).toEqual(before);
			edit((db) =>
				db
					.prepare("UPDATE engine_policy_settings SET settings_json = ?")
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
				.prepare("UPDATE engine_policy_settings SET settings_json = ?")
				.run('{"version":1}'),
		);
		expect(() => store.snapshot()).toThrow();
		expect(() => store.replace(0, input())).toThrow();
		edit((db) =>
			expect(
				db
					.prepare("SELECT revision, settings_json FROM engine_policy_settings")
					.get(),
			).toEqual({ revision: 0, settings_json: '{"version":1}' }),
		);
	});

	it("revalidates schema before writes even on an already open connection", () => {
		const store = open();
		edit((db) => db.exec("PRAGMA user_version = 2"));
		expect(() => store.replace(0, input())).toThrow(/schema/i);
		edit((db) =>
			expect(
				db.prepare("SELECT revision FROM engine_policy_settings").get()?.[
					"revision"
				],
			).toBe(0),
		);
	});

	it("does not wrap or round an exhausted revision", () => {
		const store = open();
		edit((db) =>
			db
				.prepare("UPDATE engine_policy_settings SET revision = ?")
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

	it.each(["database", "parent", "journal", "wal", "shm"])(
		"rejects unsafe %s paths through the core open boundary",
		(target) => {
			const victim = join(root, "victim");
			const db = new DatabaseSync(victim);
			db.exec("CREATE TABLE untouched (value TEXT)");
			db.close();
			const before = readFileSync(victim);
			if (target === "parent") {
				symlinkSync(root, join(root, "linked"));
				path = join(root, "linked", "policy.sqlite");
			} else
				symlinkSync(victim, target === "database" ? path : `${path}-${target}`);
			expect(() => open()).toThrow(/unsafe/i);
			expect(readFileSync(victim)).toEqual(before);
		},
	);

	it("rejects an empty path before opening a database", () => {
		expect(() => new EnginePolicySettingsStore("")).toThrow(/path/i);
		expect(() => new EnginePolicySettingsStore("   ")).toThrow(/path/i);
	});
});
