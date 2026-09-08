import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	defaultEnginePolicy,
	EnginePolicySettingsStore,
} from "../src/context/policy-settings.ts";

test("one persisted engine policy preserves memory and context budgets across reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-context-budget-")),
		path = join(root, "policy.sqlite");
	let store = new EnginePolicySettingsStore(path);
	try {
		const defaults = defaultEnginePolicy();
		expect(defaults).toHaveProperty("context");
		const updated = store.replace(0, {
			version: 2,
			memory: defaults.memory,
			context: {
				...defaults.context,
				leafInputTokens: 500,
				freshTailEntries: 2,
			},
		});
		expect(updated.revision).toBe(1);
		expect(updated.memory).toEqual(defaults.memory);
		store.close();
		store = new EnginePolicySettingsStore(path);
		expect(store.snapshot()).toEqual(updated);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("legacy policy payload gains context defaults without rewriting memory or its revision", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-context-legacy-")),
		path = join(root, "policy.sqlite");
	const initial = new EnginePolicySettingsStore(path);
	initial.close();
	const legacy = {
		version: 1,
		memory: { ...defaultEnginePolicy().memory, enabled: false, maxVisits: 17 },
	};
	const raw = JSON.stringify(legacy),
		db = new DatabaseSync(path);
	db.prepare(
		"UPDATE engine_policy_settings SET revision=7,settings_json=?",
	).run(raw);
	db.close();
	const store = new EnginePolicySettingsStore(path);
	try {
		expect(store.snapshot()).toEqual({
			version: 2,
			revision: 7,
			memory: legacy.memory,
			context: defaultEnginePolicy().context,
		});
		const check = new DatabaseSync(path);
		expect(
			check.prepare("SELECT settings_json FROM engine_policy_settings").get()?.[
				"settings_json"
			],
		).toBe(raw);
		check.close();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
