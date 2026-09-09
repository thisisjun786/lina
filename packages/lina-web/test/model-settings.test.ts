import { describe, expect, it } from "bun:test";
import type {
	CatalogModel,
	ModelTrial,
} from "../../lina-runtime/src/models/port.ts";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import { parseModelSettingsInput } from "../../lina-runtime/src/models/validation.ts";
import {
	createModelSettings,
	createProfile,
	profileFor,
	settingsInput,
} from "../client/model-settings.ts";

const settings: ModelSettings = {
	revision: 4,
	profiles: [
		{
			id: "local",
			provider: "ollama",
			model: "llama",
			reasoning: "low",
			maxOutputTokens: 500,
		},
	],
	defaultProfileId: "local",
	roles: { conversation: "local" },
	agentRoles: { alpha: { conversation: "local" } },
};

describe("model settings client contract", () => {
	it("resolves agent role before global role and strips revision from saves", () => {
		expect(profileFor(settings, "conversation", "alpha")?.model).toBe("llama");
		expect(settingsInput(settings)).toEqual(
			expect.not.objectContaining({ revision: 4 }),
		);
	});

	it("keeps a failed save from replacing the loaded snapshot", async () => {
		const client = createModelSettings(async (path, method) => {
			if (path === "/api/models") return { settings, catalog: [], active: [] };
			if (method === "PATCH") throw Error("stale revision");
			throw Error("unexpected request");
		});
		await client.load();
		await expect(client.save(settingsInput(settings))).rejects.toThrow(
			"stale revision",
		);
		expect(client.snapshot?.settings.revision).toBe(4);
	});

	it("drops a stale model load", async () => {
		let resolveFirst!: (value: unknown) => void;
		let resolveSecond!: (value: unknown) => void;
		const first = new Promise((resolve) => {
			resolveFirst = resolve;
		});
		const second = new Promise((resolve) => {
			resolveSecond = resolve;
		});
		let count = 0;
		const client = createModelSettings(async () =>
			++count === 1 ? first : second,
		);
		const old = client.load();
		const next = client.load();
		resolveFirst({ settings, catalog: [], active: [] });
		expect(await old).toBeUndefined();
		resolveSecond({ settings, catalog: [], active: [] });
		expect((await next)?.settings.revision).toBe(4);
	});
});

const catalog: CatalogModel = {
	provider: "native",
	id: "small",
	name: "Small",
	contextWindow: 8192,
	maxOutputTokens: 1024,
	reasoning: false,
	authenticated: true,
};
it("creates unique profiles from actual catalog IDs and bounds unsupported options", () => {
	const a = createProfile(catalog, [], "high", 99999);
	const b = createProfile(catalog, [a], "off", 0);
	expect(a).toMatchObject({
		provider: "native",
		model: "small",
		reasoning: "off",
		maxOutputTokens: 1024,
	});
	expect(a.id).toMatch(/^[a-z][a-z0-9-]{0,47}$/);
	expect(b.id).not.toBe(a.id);
	expect(b.maxOutputTokens).toBeGreaterThan(0);
	const input = {
		profiles: [a, b],
		roles: {},
		agentRoles: {},
		defaultProfileId: a.id,
	};
	expect(parseModelSettingsInput(input)).toEqual(input);
});
it("preserves edits made while save is pending and advances only the saved revision", async () => {
	const pending = Promise.withResolvers<unknown>();
	let body: unknown;
	const client = createModelSettings(async (_path, method, input) => {
		if (method === "PATCH") {
			body = input;
			return pending.promise;
		}
		return {
			settings: structuredClone(settings),
			catalog: [catalog],
			active: [],
		};
	});
	await client.load();
	client.edit((draft) => {
		draft.roles.summary = "local";
	});
	const save = client.save();
	client.edit((draft) => {
		draft.roles.recall = "local";
	});
	expect(body).toMatchObject({
		revision: 4,
		settings: { roles: { summary: "local" } },
	});
	pending.resolve({
		settings: {
			...settings,
			revision: 5,
			roles: { ...settings.roles, summary: "local" },
		},
	});
	await save;
	expect(client.draft?.roles.recall).toBe("local");
	expect(client.snapshot?.settings.roles.recall).toBeUndefined();
	expect(client.snapshot?.settings.revision).toBe(5);
	expect(client.dirty).toBe(true);
});
it("fences saves after closing even if transport ignores abort", async () => {
	const pending = Promise.withResolvers<unknown>();
	const client = createModelSettings(async (_path, method) =>
		method === "GET"
			? { settings, catalog: [catalog], active: [] }
			: pending.promise,
	);
	await client.load();
	const saving = client.save(settingsInput(settings));
	client.close();
	pending.resolve({ settings: { ...settings, revision: 9 } });
	expect(await saving).toBeUndefined();
	expect(client.snapshot?.settings.revision).toBe(4);
});
it("uses the actual trial DTO without fictional latency or usage fields", async () => {
	const trial: ModelTrial = {
		provider: "native",
		model: "actual",
		text: "answer",
		durationMs: 37,
		inputTokens: 8,
		outputTokens: 2,
	};
	const client = createModelSettings(async (_path, method) =>
		method === "GET" ? { settings, catalog: [catalog], active: [] } : trial,
	);
	await client.load();
	expect(await client.test("local", "hello")).toEqual(trial);
});

it("resolves distinct agent, global role and default selections in order", () => {
	const a = createProfile(catalog, [], "off", 100);
	const b = createProfile(catalog, [a], "off", 200);
	const c = createProfile(catalog, [a, b], "off", 300);
	const data: ModelSettings = {
		revision: 1,
		profiles: [a, b, c],
		defaultProfileId: a.id,
		roles: { conversation: b.id },
		agentRoles: { alpha: { conversation: c.id } },
	};
	expect(profileFor(data, "conversation", "alpha")?.id).toBe(c.id);
	expect(profileFor(data, "conversation", "beta")?.id).toBe(b.id);
	expect(profileFor(data, "summary", "alpha")).toBeNull();
});
it("fences a trial after closing and preserves draft on failed reload", async () => {
	const pending = Promise.withResolvers<unknown>();
	let loads = 0;
	const client = createModelSettings(async (_path, method) => {
		if (method === "POST") return pending.promise;
		if (++loads > 1) throw Error("offline");
		return { settings, catalog: [catalog], active: [] };
	});
	await client.load();
	client.edit((draft) => {
		draft.roles.summary = "local";
	});
	const trial = client.test("local", "hello");
	client.close();
	pending.resolve({
		provider: "native",
		model: "actual",
		text: "late",
		durationMs: 1,
		inputTokens: 1,
		outputTokens: 1,
	} satisfies ModelTrial);
	expect(await trial).toBeUndefined();
	await expect(client.load(true)).rejects.toThrow("offline");
	expect(client.draft?.roles.summary).toBe("local");
});
