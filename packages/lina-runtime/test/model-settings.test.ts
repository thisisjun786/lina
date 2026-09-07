import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelSettingsStore } from "../src/models/settings.ts";
import type { ModelSettingsInput } from "../src/models/types.ts";

function input(): ModelSettingsInput {
	return {
		profiles: [
			{
				id: "main",
				provider: "native",
				model: "conversation-v1",
				reasoning: "high",
				maxOutputTokens: 4096,
			},
			{
				id: "small",
				provider: "local",
				model: "family/model:small",
				reasoning: "off",
				maxOutputTokens: 512,
			},
		],
		defaultProfileId: "main",
		roles: {
			summary: "small",
			observation: "small",
			reflection: "main",
			recall: "small",
		},
		agentRoles: { lina: { conversation: "small" } },
	};
}

describe("model settings SQLite store", () => {
	let root: string;
	let path: string;
	let stores: ModelSettingsStore[];
	function open(): ModelSettingsStore {
		const store = new ModelSettingsStore(path);
		stores.push(store);
		return store;
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lina-model-settings-"));
		path = join(root, "models.sqlite");
		stores = [];
	});
	afterEach(() => {
		for (const store of stores) store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects stale writes across independent connections without losing the winner", () => {
		const first = open();
		const second = open();
		expect(first.snapshot().revision).toBe(0);
		expect(second.snapshot().revision).toBe(0);
		expect(first.replace(0, input()).revision).toBe(1);
		expect(() =>
			second.replace(0, { ...input(), defaultProfileId: "small" }),
		).toThrow(/stale.*revision/i);
		expect(second.snapshot()).toEqual({ revision: 1, ...input() });
		expect(
			second.replace(1, { ...input(), defaultProfileId: "small" }).revision,
		).toBe(2);
		expect(first.snapshot().defaultProfileId).toBe("small");
	});

	// Keep every referenced profile present so unrelated reference checks cannot
	// mask a missing validation guard on the intentionally changed field.
	function withProfile(patch: Record<string, unknown>): unknown {
		const base = input();
		return {
			...base,
			profiles: base.profiles.map((item, index) =>
				index === 0 ? { ...item, ...patch } : item,
			),
		};
	}

	const invalid: [string, () => unknown][] = [
		["revision in public input", () => ({ ...input(), revision: 100 })],
		["unknown top-level field", () => ({ ...input(), endpoints: [] })],
		["credential", () => withProfile({ apiKey: "synthetic-secret-marker" })],
		["endpoint", () => withProfile({ baseUrl: "https://invalid.example" })],
		["unknown option", () => withProfile({ temperature: 0.5 })],
		["unknown reasoning", () => withProfile({ reasoning: "extreme" })],
		[
			"duplicate profile",
			() => ({
				...input(),
				profiles: [...input().profiles, input().profiles[0]],
			}),
		],
		[
			"unsafe profile ID",
			() => ({
				...input(),
				profiles: [
					...input().profiles,
					{ ...input().profiles[0], id: "../main" },
				],
			}),
		],
		[
			"unknown default reference",
			() => ({ ...input(), defaultProfileId: "missing" }),
		],
		[
			"unknown global reference",
			() => ({ ...input(), roles: { summary: "missing" } }),
		],
		[
			"unknown agent reference",
			() => ({ ...input(), agentRoles: { lina: { recall: "missing" } } }),
		],
		["unknown global role", () => ({ ...input(), roles: { planner: "main" } })],
		[
			"unknown agent role",
			() => ({ ...input(), agentRoles: { lina: { planner: "main" } } }),
		],
		[
			"null role reference",
			() => ({ ...input(), roles: { conversation: null } }),
		],
		[
			"undefined role reference",
			() => ({ ...input(), roles: { conversation: undefined } }),
		],
		[
			"unsafe agent ID",
			() => ({
				...input(),
				agentRoles: { "../lina": { conversation: "main" } },
			}),
		],
		["uppercase agent ID", () => ({ ...input(), agentRoles: { Lina: {} } })],
		[
			"agent ID with trailing newline",
			() => ({ ...input(), agentRoles: { "lina\n": {} } }),
		],
		[
			"profile ID with trailing newline",
			() => ({
				...input(),
				profiles: [
					...input().profiles,
					{ ...input().profiles[0], id: "main\n" },
				],
			}),
		],
		[
			"overlong agent ID",
			() => ({ ...input(), agentRoles: { ["a".repeat(49)]: {} } }),
		],
		[
			"prototype agent ID",
			() => ({
				...input(),
				agentRoles: JSON.parse('{"__proto__":{"conversation":"main"}}'),
			}),
		],
		["blank provider", () => withProfile({ provider: " " })],
		["blank model", () => withProfile({ model: "" })],
		["control character", () => withProfile({ model: "model\u0000" })],
		["C1 control character", () => withProfile({ model: "model\u0085" })],
		["overlong model", () => withProfile({ model: "m".repeat(1025) })],
		["zero output budget", () => withProfile({ maxOutputTokens: 0 })],
		["negative output budget", () => withProfile({ maxOutputTokens: -1 })],
		["fractional output budget", () => withProfile({ maxOutputTokens: 1.5 })],
		[
			"unbounded output budget",
			() => withProfile({ maxOutputTokens: Number.MAX_SAFE_INTEGER }),
		],
		[
			"nonfinite output budget",
			() => withProfile({ maxOutputTokens: Number.NaN }),
		],
		["missing fields", () => ({ profiles: [] })],
		["array input", () => []],
		["null input", () => null],
	];
	it.each(invalid)("rejects %s before mutation", (_label, candidate) => {
		const store = open();
		const saved = store.replace(0, input());
		// Exercise the runtime JSON boundary with intentionally invalid data.
		expect(() => store.replace(1, candidate() as ModelSettingsInput)).toThrow();
		expect(store.snapshot()).toEqual(saved);
		store.close();
		expect(open().snapshot()).toEqual(saved);
		expect(
			readFileSync(path).includes(Buffer.from("synthetic-secret-marker")),
		).toBe(false);
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

	it("starts at native defaults and persists complete replacements through reopen", () => {
		const store = open();
		const empty = {
			profiles: [],
			defaultProfileId: null,
			roles: {},
			agentRoles: {},
		};
		expect(store.snapshot()).toEqual({ revision: 0, ...empty });
		expect(store.replace(0, input())).toEqual({ revision: 1, ...input() });
		store.close();
		const reopened = open();
		expect(reopened.snapshot()).toEqual({ revision: 1, ...input() });
		expect(reopened.replace(1, empty)).toEqual({ revision: 2, ...empty });
		reopened.close();
		expect(open().snapshot()).toEqual({ revision: 2, ...empty });
		expect(readFileSync(path).subarray(0, 16).toString()).toBe(
			"SQLite format 3\u0000",
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("detaches input, replace return and snapshots including nested maps and profiles", () => {
		const store = open();
		const supplied = input();
		const saved = store.replace(0, supplied);
		const suppliedProfile = supplied.profiles[0];
		const savedProfile = saved.profiles[0];
		const savedAgent = saved.agentRoles["lina"];
		if (!suppliedProfile || !savedProfile || !savedAgent)
			throw new Error("missing fixture data");
		suppliedProfile.model = "changed-input";
		savedProfile.model = "changed-return";
		savedAgent.conversation = "main";
		const snapshot = store.snapshot();
		snapshot.profiles.length = 0;
		snapshot.roles.summary = "main";
		const snapshotAgent = snapshot.agentRoles["lina"];
		if (!snapshotAgent) throw new Error("missing fixture agent");
		snapshotAgent.conversation = "main";
		expect(store.snapshot()).toEqual({ revision: 1, ...input() });
	});

	it("closes idempotently and rejects further operations", () => {
		const store = open();
		store.close();
		expect(() => store.close()).not.toThrow();
		expect(() => store.snapshot()).toThrow(/closed/i);
		expect(() => store.replace(0, input())).toThrow(/closed/i);
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
				path = join(root, "linked", "models.sqlite");
			} else
				symlinkSync(victim, target === "database" ? path : `${path}-${target}`);
			expect(() => open()).toThrow(/unsafe/i);
			expect(readFileSync(victim)).toEqual(before);
		},
	);
});
