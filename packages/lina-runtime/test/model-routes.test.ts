import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveModelRoute } from "../src/models/routes.ts";
import { ModelSettingsStore } from "../src/models/settings.ts";
import type { ModelProfile, ModelSettings } from "../src/models/types.ts";
import { parseModelSettingsInput } from "../src/models/validation.ts";

function profile(
	id: string,
	reasoning: ModelProfile["reasoning"] = "low",
	maxOutputTokens?: number,
): ModelProfile {
	const value: ModelProfile = {
		id,
		provider: "synthetic",
		model: `model-${id}`,
		reasoning,
	};
	if (maxOutputTokens !== undefined) value.maxOutputTokens = maxOutputTokens;
	return value;
}

function settings(): ModelSettings {
	return {
		revision: 3,
		profiles: [
			profile("global"),
			profile("agent"),
			profile("tier"),
			profile("override"),
		],
		defaultProfileId: "global",
		roles: {},
		agentRoles: {},
		routes: {
			version: 1,
			tiers: {
				quick: { profileId: "tier", reasoning: "off" },
				standard: { profileId: "tier", reasoning: "low" },
				deep: { profileId: "tier", reasoning: "medium" },
				intensive: { profileId: "tier", reasoning: "high" },
			},
			roleTiers: { summary: "deep" },
		},
	};
}

it("rejects direct unconfigured or conflicting routes and conversation tiers", () => {
	const saved = settings();
	const { routes: _routes, ...legacy } = saved;
	expect(() =>
		resolveModelRoute(legacy, "summary", undefined, { tier: "quick" }),
	).toThrow();
	expect(() =>
		resolveModelRoute(saved, "conversation", undefined, { tier: "deep" }),
	).toThrow();
	expect(() =>
		resolveModelRoute(saved, "summary", undefined, {
			tier: "quick",
			overrideProfileId: "override",
		}),
	).toThrow();
});
it("preserves explicit agent choices while activating global tiers", () => {
	const saved = settings();
	expect(resolveModelRoute(saved, "summary")?.profile).toMatchObject({
		id: "tier",
		reasoning: "medium",
	});
	saved.agentRoles["lina"] = { summary: "agent" };
	expect(resolveModelRoute(saved, "summary", "lina")?.profile.id).toBe("agent");
	expect(
		resolveModelRoute(saved, "summary", "lina", {
			overrideProfileId: "override",
		})?.profile.id,
	).toBe("override");
	expect(
		resolveModelRoute(saved, "summary", "lina", { tier: "intensive" })?.profile
			.reasoning,
	).toBe("high");
	expect(resolveModelRoute(saved, "conversation")?.profile.id).toBe("global");
	expect(resolveModelRoute(saved, "vision")?.profile.id).toBe("global");
});
it("validates stored routes strictly and preserves legacy absence", () => {
	const saved = settings();
	const { revision: _revision, ...input } = saved;
	expect(parseModelSettingsInput(input)).toEqual(input);
	for (const routes of [
		undefined,
		{ ...input.routes, version: 2 },
		{ ...input.routes, roleTiers: { conversation: "quick" } },
		{ ...input.routes, tiers: { quick: { profileId: "tier" } } },
		{ ...input.routes, roleTiers: { summary: "unknown" } },
	])
		expect(() => parseModelSettingsInput({ ...input, routes })).toThrow();
	const { routes: _routes, ...legacy } = input;
	expect(parseModelSettingsInput(legacy)).toEqual(legacy);
});
it("returns detached profiles with saved revision", () => {
	const saved = settings();
	const result = resolveModelRoute(saved, "summary");
	expect(result).toMatchObject({
		mode: "tier",
		settingsRevision: 3,
		tier: "deep",
	});
	if (!result) throw Error("missing result");
	result.profile.reasoning = "off";
	expect(resolveModelRoute(saved, "summary")?.profile.reasoning).toBe("medium");
});

it("reopens legacy and tier settings and rejects corrupted routes at startup", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-routes-"));
	const path = join(root, "models.db");
	try {
		const { revision: _revision, ...input } = settings();
		const { routes: _routes, ...legacy } = input;
		let store = new ModelSettingsStore(path);
		store.replace(0, legacy);
		store.close();
		store = new ModelSettingsStore(path);
		expect(Object.hasOwn(store.snapshot(), "routes")).toBe(false);
		store.replace(1, input);
		store.close();
		store = new ModelSettingsStore(path);
		expect(resolveModelRoute(store.snapshot(), "summary")).toMatchObject({
			tier: "deep",
			settingsRevision: 2,
			profile: { id: "tier", reasoning: "medium" },
		});
		expect(() => store.replace(1, input)).toThrow();
		store.close();
		const db = new DatabaseSync(path);
		try {
			db.prepare(
				"UPDATE model_settings SET settings_json = ? WHERE id = 1",
			).run(
				JSON.stringify({
					...input,
					routes: { ...input.routes, roleTiers: { summary: "corrupt" } },
				}),
			);
		} finally {
			db.close();
		}
		expect(() => new ModelSettingsStore(path)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
