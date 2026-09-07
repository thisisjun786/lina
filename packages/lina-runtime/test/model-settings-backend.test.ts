import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveProfile } from "../src/models/selection.ts";
import { ModelSettingsStore } from "../src/models/settings.ts";
import {
	MODEL_ROLES,
	type ModelProfile,
	type ModelSettings,
	type ModelSettingsInput,
} from "../src/models/types.ts";

/** Legacy on-disk shape: every profile carries an explicit budget, no reasoning maps. */
function legacy(): ModelSettingsInput {
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
		roles: { summary: "small", recall: "small" },
		agentRoles: { lina: { conversation: "small" } },
	};
}

function extended(): ModelSettingsInput {
	return {
		profiles: [
			{
				id: "main",
				provider: "native",
				model: "conversation-v1",
				reasoning: "medium",
			},
			{
				id: "small",
				provider: "local",
				model: "family/model:small",
				reasoning: "off",
				maxOutputTokens: 512,
			},
			{ id: "eyes", provider: "native", model: "vision-v1", reasoning: "off" },
		],
		defaultProfileId: "main",
		roles: { summary: "small", vision: "eyes" },
		agentRoles: { lina: { conversation: "small", vision: "eyes" } },
		roleReasoning: { conversation: "high", summary: "low", vision: "off" },
		agentRoleReasoning: { lina: { conversation: "off", recall: "low" } },
	};
}

function rawJson(path: string): Record<string, unknown> {
	const db = new DatabaseSync(path);
	try {
		const row = db
			.prepare("SELECT settings_json FROM model_settings WHERE id = 1")
			.get();
		return JSON.parse(String(row?.["settings_json"])) as Record<
			string,
			unknown
		>;
	} finally {
		db.close();
	}
}

describe("backend model settings: optional budgets and independent reasoning", () => {
	let root: string;
	let path: string;
	let stores: ModelSettingsStore[];
	function open(): ModelSettingsStore {
		const store = new ModelSettingsStore(path);
		stores.push(store);
		return store;
	}
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "lina-model-backend-"));
		path = join(root, "models.sqlite");
		stores = [];
	});
	afterEach(() => {
		for (const store of stores) store.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps legacy JSON byte-shape: no new keys are written for legacy input", () => {
		const store = open();
		expect(store.replace(0, legacy())).toEqual({ revision: 1, ...legacy() });
		expect(Object.keys(rawJson(path)).sort()).toEqual([
			"agentRoles",
			"defaultProfileId",
			"profiles",
			"roles",
		]);
		store.close();
		const reopened = open();
		const snapshot = reopened.snapshot();
		expect(snapshot).toEqual({ revision: 1, ...legacy() });
		expect("roleReasoning" in snapshot).toBe(false);
		expect("agentRoleReasoning" in snapshot).toBe(false);
	});

	it("persists omitted budgets and reasoning maps through CAS and reopen", () => {
		const first = open();
		const second = open();
		expect(first.replace(0, extended())).toEqual({
			revision: 1,
			...extended(),
		});
		expect(() => second.replace(0, extended())).toThrow(/stale.*revision/i);
		expect(second.snapshot()).toEqual({ revision: 1, ...extended() });
		const main = second.snapshot().profiles.find((p) => p.id === "main");
		expect(main && "maxOutputTokens" in main).toBe(false);
		const raw = rawJson(path);
		expect(raw["roleReasoning"]).toEqual(extended().roleReasoning);
		expect(raw["agentRoleReasoning"]).toEqual(extended().agentRoleReasoning);
		first.close();
		second.close();
		const reopened = open();
		expect(reopened.snapshot()).toEqual({ revision: 1, ...extended() });
		// Changing only the global model keeps independent reasoning intact.
		const next = { ...extended(), defaultProfileId: "small" };
		expect(reopened.replace(1, next)).toEqual({ revision: 2, ...next });
		reopened.close();
		expect(open().snapshot().roleReasoning).toEqual(extended().roleReasoning);
	});

	it("accepts the vision role everywhere a role is bound", () => {
		expect(MODEL_ROLES).toContain("vision");
		const store = open();
		const candidate = extended();
		candidate.roles = { vision: "eyes" };
		candidate.agentRoles = { lina: { vision: "main" } };
		candidate.roleReasoning = { vision: "low" };
		candidate.agentRoleReasoning = { lina: { vision: "high" } };
		expect(store.replace(0, candidate)).toEqual({ revision: 1, ...candidate });
	});

	const invalid: [string, () => unknown][] = [
		[
			"present-but-undefined budget",
			() => ({
				...extended(),
				profiles: extended().profiles.map((p, i) =>
					i === 0 ? { ...p, maxOutputTokens: undefined } : p,
				),
			}),
		],
		[
			"null budget",
			() => ({
				...extended(),
				profiles: extended().profiles.map((p, i) =>
					i === 0 ? { ...p, maxOutputTokens: null } : p,
				),
			}),
		],
		[
			"string budget",
			() => ({
				...extended(),
				profiles: extended().profiles.map((p, i) =>
					i === 0 ? { ...p, maxOutputTokens: "4096" } : p,
				),
			}),
		],
		[
			"unknown reasoning role",
			() => ({ ...extended(), roleReasoning: { planner: "low" } }),
		],
		[
			"invalid role reasoning",
			() => ({ ...extended(), roleReasoning: { summary: "max" } }),
		],
		[
			"null role reasoning",
			() => ({ ...extended(), roleReasoning: { summary: null } }),
		],
		["array role reasoning", () => ({ ...extended(), roleReasoning: [] })],
		["null role reasoning map", () => ({ ...extended(), roleReasoning: null })],
		[
			"present-but-undefined role reasoning map",
			() => ({ ...extended(), roleReasoning: undefined }),
		],
		[
			"unknown agent reasoning role",
			() => ({
				...extended(),
				agentRoleReasoning: { lina: { planner: "low" } },
			}),
		],
		[
			"invalid agent reasoning value",
			() => ({ ...extended(), agentRoleReasoning: { lina: { recall: true } } }),
		],
		[
			"unsafe agent reasoning id",
			() => ({
				...extended(),
				agentRoleReasoning: { "../lina": { recall: "low" } },
			}),
		],
		[
			"uppercase agent reasoning id",
			() => ({
				...extended(),
				agentRoleReasoning: { Lina: { recall: "low" } },
			}),
		],
		[
			"prototype agent reasoning id",
			() => ({
				...extended(),
				agentRoleReasoning: JSON.parse('{"__proto__":{"recall":"low"}}'),
			}),
		],
		[
			"array agent reasoning map",
			() => ({ ...extended(), agentRoleReasoning: [] }),
		],
		[
			"string agent reasoning entry",
			() => ({ ...extended(), agentRoleReasoning: { lina: "low" } }),
		],
		["unknown extra map", () => ({ ...extended(), roleBudgets: {} })],
		[
			"profile reasoning override key",
			() => ({
				...extended(),
				profiles: extended().profiles.map((p, i) =>
					i === 0 ? { ...p, roleReasoning: { summary: "low" } } : p,
				),
			}),
		],
	];
	it.each(invalid)("rejects %s before mutation", (_label, candidate) => {
		const store = open();
		const saved = store.replace(0, extended());
		expect(() => store.replace(1, candidate() as ModelSettingsInput)).toThrow();
		expect(store.snapshot()).toEqual(saved);
		store.close();
		expect(open().snapshot()).toEqual(saved);
	});
});

describe("backend model selection: reasoning cascade", () => {
	function profile(
		id: string,
		reasoning: ModelProfile["reasoning"] = "low",
	): ModelProfile {
		return { id, provider: "synthetic", model: "model-" + id, reasoning };
	}
	function settings(): ModelSettings {
		return {
			revision: 3,
			profiles: [
				profile("global", "medium"),
				profile("agent", "low"),
				profile("override", "high"),
				profile("default", "off"),
			],
			defaultProfileId: "default",
			roles: { conversation: "global" },
			agentRoles: { lina: { summary: "agent" } },
			roleReasoning: { conversation: "high", summary: "off" },
			agentRoleReasoning: {
				lina: { summary: "high", conversation: "off" },
				rumi: { conversation: "medium" },
			},
		};
	}
	it("agent reasoning overlays global role reasoning which overlays profile reasoning", () => {
		expect(resolveProfile(settings(), "conversation", "lina")).toEqual({
			...profile("global", "off"),
		});
		expect(resolveProfile(settings(), "conversation", "rumi")).toEqual({
			...profile("global", "medium"),
		});
		expect(resolveProfile(settings(), "conversation")).toEqual({
			...profile("global", "high"),
		});
		expect(resolveProfile(settings(), "summary", "lina")).toEqual({
			...profile("agent", "high"),
		});
		expect(resolveProfile(settings(), "summary", "rumi")).toEqual({
			...profile("default", "off"),
		});
		expect(resolveProfile(settings(), "recall", "lina")).toEqual({
			...profile("default", "off"),
		});
	});
	it("an inherited role follows a global model change but keeps its own reasoning", () => {
		const value = settings();
		value.roles = { conversation: "agent" };
		expect(resolveProfile(value, "conversation", "lina")).toEqual({
			...profile("agent", "off"),
		});
		expect(resolveProfile(value, "conversation")).toEqual({
			...profile("agent", "high"),
		});
	});
	it("explicit override bypasses role reasoning and keeps the profile reasoning exactly", () => {
		expect(
			resolveProfile(settings(), "conversation", "lina", "override"),
		).toEqual(profile("override", "high"));
		expect(
			resolveProfile(settings(), "conversation", "lina", "default"),
		).toEqual(profile("default", "off"));
	});
	it("reasoning maps alone never select a model", () => {
		const value = settings();
		value.roles = {};
		value.agentRoles = {};
		value.defaultProfileId = null;
		expect(resolveProfile(value, "conversation", "lina")).toBeNull();
		expect(resolveProfile(value, "vision", "lina")).toBeNull();
	});
	it("legacy snapshots without maps resolve unchanged and stay frozen", () => {
		const value = settings();
		delete value.roleReasoning;
		delete value.agentRoleReasoning;
		Object.freeze(value.profiles);
		for (const item of value.profiles) Object.freeze(item);
		Object.freeze(value);
		expect(resolveProfile(value, "conversation", "lina")).toEqual(
			profile("global", "medium"),
		);
	});
});
