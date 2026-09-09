import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import type { CatalogModel } from "../src/models/port.ts";
import type { ModelSettingsInput } from "../src/models/types.ts";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("model and mind API separate saved selection from isolated inference and private rooms", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-model-api-"));
	let calls = 0;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "BASE",
		createApp: (o) =>
			startPersistentApp({
				...o,
				createSession: async (s) => {
					const b = initializeSessionFile(s.sessionFile, s.workspace);
					const native = new ControlledSession(b.sessionId, b.sessionFile);
					return Object.assign(native, {
						models: {
							catalog: () => [
								{
									provider: "test",
									id: "one",
									name: "One",
									contextWindow: 96000,
									maxOutputTokens: 4096,
									reasoning: true,
									authenticated: true,
								},
							],
							state: () => ({
								provider: "test",
								model: "one",
								settingsRevision: 0,
								error: null,
							}),
							test: async () => {
								calls++;
								return {
									provider: "test",
									model: "one",
									text: "synthetic response",
									inputTokens: 4,
									outputTokens: 2,
									durationMs: 1,
								};
							},
						},
					});
				},
			}),
	});
	const server = await startFleetServer(fleet, 0, process.cwd());
	const url = `http://127.0.0.1:${server.port}`;
	try {
		const listing = await fetch(url + "/api/models");
		expect(listing.status).toBe(200);
		expect(
			((await listing.json()) as { catalog: { id: string }[] }).catalog[0]?.id,
		).toBe("one");
		const input = {
			profiles: [
				{
					id: "one",
					provider: "test",
					model: "one",
					reasoning: "low",
					maxOutputTokens: 2048,
				},
			],
			defaultProfileId: "one",
			roles: {},
			agentRoles: {},
		};
		const saved = await fetch(url + "/api/models/settings", {
			method: "PATCH",
			body: JSON.stringify({ revision: 0, settings: input }),
		});
		expect(saved.status).toBe(200);
		const before = (await fleet.app("lina")).runtime.snapshot();
		const trial = await fetch(url + "/api/models/test", {
			method: "POST",
			body: JSON.stringify({ profileId: "one", prompt: "hello" }),
		});
		expect(trial.status).toBe(200);
		expect(calls).toBe(1);
		expect((await fleet.app("lina")).runtime.snapshot()).toEqual(before);
		const stale = await fetch(url + "/api/models/settings", {
			method: "PATCH",
			body: JSON.stringify({ revision: 0, settings: input }),
		});
		expect(stale.status).toBe(409);
		const denied = await fetch(url + "/api/models", {
			headers: { origin: "https://evil.test" },
		});
		expect(denied.status).toBe(403);
		const mind = await fetch(url + "/api/agents/lina/mind");
		expect(mind.status).toBe(200);
		expect(
			((await mind.json()) as { state: { agentId: string } }).state.agentId,
		).toBe("lina");
		const kai = fleet.presets.find((p) => p.id === "kai");
		if (!kai) throw Error("seed");
		fleet.agents.create(kai);
		const unopened = await fetch(url + "/api/agents/kai/mind");
		expect(await unopened.json()).toEqual({
			available: false,
			reason: "room-not-open",
		});
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

const routeCatalog: CatalogModel[] = [
	{
		provider: "test",
		id: "one",
		name: "One",
		contextWindow: 96000,
		maxOutputTokens: 4096,
		reasoning: true,
		reasoningEfforts: ["low", "medium"],
		authenticated: true,
		imageInput: true,
	},
	{
		provider: "test",
		id: "text",
		name: "Text",
		contextWindow: 32000,
		maxOutputTokens: 2048,
		reasoning: false,
		authenticated: true,
	},
	{
		provider: "test",
		id: "limited",
		name: "Limited",
		contextWindow: 16000,
		maxOutputTokens: 1024,
		reasoning: true,
		reasoningEfforts: ["low"],
		authenticated: true,
	},
	{
		provider: "test",
		id: "eye",
		name: "Eye",
		contextWindow: 32000,
		maxOutputTokens: 2048,
		reasoning: false,
		authenticated: false,
		imageInput: true,
	},
	{
		provider: "test",
		id: "sight",
		name: "Sight",
		contextWindow: 32000,
		maxOutputTokens: 2048,
		reasoning: true,
		reasoningEfforts: ["low", "medium"],
		authenticated: true,
		imageInput: true,
		supportedRoles: ["vision"],
	},
];
const routeProfiles = {
	one: { id: "one", provider: "test", model: "one", reasoning: "low" as const },
	text: {
		id: "text",
		provider: "test",
		model: "text",
		reasoning: "off" as const,
	},
	limited: {
		id: "limited",
		provider: "test",
		model: "limited",
		reasoning: "low" as const,
	},
	eye: { id: "eye", provider: "test", model: "eye", reasoning: "off" as const },
	stale: {
		id: "stale",
		provider: "gone",
		model: "retired",
		reasoning: "off" as const,
		maxOutputTokens: 99999,
	},
	sight: {
		id: "sight",
		provider: "test",
		model: "sight",
		reasoning: "low" as const,
	},
};

function allTiers(
	profileId: string,
	extra: {
		reasoning?: "off" | "low" | "medium" | "high";
		maxOutputTokens?: number;
	} = {},
) {
	return {
		quick: { profileId, ...extra },
		standard: { profileId, ...extra },
		deep: { profileId, ...extra },
		intensive: { profileId, ...extra },
	};
}

test("model settings API validates referenced tier routes and retains them on stale patches", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-model-api-routes-"));
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "BASE",
		createApp: (o) =>
			startPersistentApp({
				...o,
				createSession: async (s) => {
					const b = initializeSessionFile(s.sessionFile, s.workspace);
					const native = new ControlledSession(b.sessionId, b.sessionFile);
					return Object.assign(native, {
						models: {
							catalog: () => routeCatalog,
							state: () => ({
								provider: "test",
								model: "one",
								settingsRevision: 0,
								error: null,
							}),
							test: async () => ({
								provider: "test",
								model: "one",
								text: "x",
								inputTokens: 1,
								outputTokens: 1,
								durationMs: 1,
							}),
						},
					});
				},
			}),
	});
	const server = await startFleetServer(fleet, 0, process.cwd());
	const url = "http://127.0.0.1:" + server.port;
	let revision = 0;
	const patch = async (settings: unknown) => {
		const response = await fetch(url + "/api/models/settings", {
			method: "PATCH",
			body: JSON.stringify({ revision, settings }),
		});
		const body = (await response.json()) as {
			settings?: { revision: number; routes?: unknown };
			error?: string;
		};
		if (response.status === 200 && body.settings)
			revision = body.settings.revision;
		return { status: response.status, body };
	};
	const base = (): ModelSettingsInput & {
		routes?: {
			version: 1;
			tiers: ReturnType<typeof allTiers>;
			roleTiers: Record<string, string>;
		};
	} => ({
		profiles: [
			routeProfiles.one,
			routeProfiles.text,
			routeProfiles.limited,
			routeProfiles.eye,
			routeProfiles.stale,
			routeProfiles.sight,
		],
		defaultProfileId: "one",
		roles: {},
		agentRoles: {},
	});
	try {
		const same = {
			version: 1 as const,
			tiers: allTiers("one"),
			roleTiers: { summary: "standard" },
		};
		const saved = await patch({ ...base(), routes: same });
		expect(saved.status).toBe(200);
		expect(saved.body.settings?.routes).toEqual(same);
		const listing = (await (await fetch(url + "/api/models")).json()) as {
			settings: { routes?: unknown };
		};
		expect(listing.settings.routes).toEqual(same);

		const mixed = {
			version: 1 as const,
			tiers: {
				quick: { profileId: "one", reasoning: "off" as const },
				standard: { profileId: "one", reasoning: "low" as const },
				deep: { profileId: "one", reasoning: "medium" as const },
				intensive: { profileId: "one", reasoning: "low" as const },
			},
			roleTiers: { summary: "deep", vision: "quick" },
		};
		expect((await patch({ ...base(), routes: mixed })).status).toBe(200);

		expect(
			(
				await patch({
					...base(),
					routes: { version: 1, tiers: allTiers("one"), roleTiers: {} },
				})
			).status,
		).toBe(200);

		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("text", { reasoning: "high" }),
						roleTiers: { summary: "standard" },
					},
				})
			).status,
		).toBe(200);

		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("limited", { reasoning: "high" }),
						roleTiers: { recall: "standard" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("limited", { reasoning: "off" }),
						roleTiers: { recall: "standard" },
					},
				})
			).status,
		).toBe(200);

		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("one", { maxOutputTokens: 8192 }),
						roleTiers: {},
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("stale"),
						roleTiers: { summary: "quick" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("eye"),
						roleTiers: { summary: "quick" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("text"),
						roleTiers: { vision: "standard" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("one"),
						roleTiers: { vision: "standard" },
					},
				})
			).status,
		).toBe(200);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("sight"),
						roleTiers: {},
					},
				})
			).status,
		).toBe(200);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("sight"),
						roleTiers: { summary: "quick" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("sight"),
						roleTiers: { vision: "quick" },
					},
				})
			).status,
		).toBe(200);

		const kept = {
			version: 1 as const,
			tiers: allTiers("one", { reasoning: "medium" }),
			roleTiers: { observation: "intensive" },
		};
		expect((await patch({ ...base(), routes: kept })).status).toBe(200);
		const stale = await fetch(url + "/api/models/settings", {
			method: "PATCH",
			body: JSON.stringify({
				revision: 0,
				settings: { ...base(), routes: kept },
			}),
		});
		expect(stale.status).toBe(409);
		expect(fleet.modelSettings.snapshot()).toMatchObject({
			revision,
			routes: kept,
		});
		expect(
			(
				await patch({
					...base(),
					routes: { version: 2, tiers: allTiers("one"), roleTiers: {} },
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: {
							quick: { profileId: "one" },
							standard: { profileId: "one" },
							deep: { profileId: "one" },
						},
						roleTiers: {},
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("one"),
						roleTiers: { conversation: "quick" },
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					routes: {
						version: 1,
						tiers: allTiers("one"),
						roleTiers: { summary: "turbo" },
					},
				})
			).status,
		).toBe(400);
		expect((await patch({ ...base(), routes: null })).status).toBe(400);
		expect(fleet.modelSettings.snapshot()).toMatchObject({
			revision,
			routes: kept,
		});
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
