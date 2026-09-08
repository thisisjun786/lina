import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	defaultEnginePolicy,
	EnginePolicySettingsStore,
} from "../src/context/policy-settings.ts";

test("resource policy survives legacy edits, CAS conflicts and reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-policy-"));
	const path = join(root, "policy.sqlite");
	const store = new EnginePolicySettingsStore(path);
	try {
		const { revision: _revision, ...initial } = defaultEnginePolicy();
		expect(initial.version).toBe(3);
		const resources = { ...initial.resources, enabled: false, maxCalls: 2 };
		const saved = store.replace(0, { ...initial, resources });
		expect(saved.resources).toEqual(resources);
		const legacy = store.replace(1, {
			version: 1,
			memory: { ...initial.memory, enabled: false },
		});
		expect(legacy.resources).toEqual(resources);
		expect(() => store.replace(1, initial)).toThrow(/stale/);
		const contextOnly = store.replace(2, {
			version: 2,
			memory: initial.memory,
			context: initial.context,
		});
		expect(contextOnly.resources).toEqual(resources);
		store.close();
		const reopened = new EnginePolicySettingsStore(path);
		try {
			expect(reopened.snapshot()).toEqual(contextOnly);
		} finally {
			reopened.close();
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("v2 policy read adds resources without rewriting stored JSON or revision", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-v2-"));
	const path = join(root, "policy.sqlite");
	const { revision: _revision, ...defaults } = defaultEnginePolicy();
	new EnginePolicySettingsStore(path).close();
	const legacy = JSON.stringify({
		version: 2,
		memory: defaults.memory,
		context: defaults.context,
	});
	const db = new DatabaseSync(path);
	try {
		db.prepare(
			"UPDATE engine_policy_settings SET settings_json=?, revision=7",
		).run(legacy);
		const store = new EnginePolicySettingsStore(path);
		try {
			expect(store.snapshot().version).toBe(3);
			expect(store.snapshot().resources).toEqual(defaults.resources);
			expect(store.snapshot().revision).toBe(7);
			expect(
				db.prepare("SELECT settings_json FROM engine_policy_settings").get()?.[
					"settings_json"
				],
			).toBe(legacy);
			expect(() =>
				store.replace(7, {
					...defaults,
					resources: { ...defaults.resources, maxCalls: 0 },
				}),
			).toThrow();
			expect(() =>
				store.replace(7, {
					...defaults,
					resources: { ...defaults.resources, maxAttempts: 4 },
				}),
			).toThrow();
			expect(store.snapshot().revision).toBe(7);
		} finally {
			store.close();
		}
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
