import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import type { CatalogModel } from "../src/models/port.ts";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const catalog: CatalogModel[] = [
	{
		provider: "test",
		id: "one",
		name: "One",
		contextWindow: 96000,
		maxOutputTokens: 4096,
		reasoning: true,
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
		id: "eye",
		name: "Eye",
		contextWindow: 32000,
		maxOutputTokens: 2048,
		reasoning: false,
		authenticated: false,
		imageInput: true,
	},
];
const profiles = {
	one: { id: "one", provider: "test", model: "one", reasoning: "low" },
	text: { id: "text", provider: "test", model: "text", reasoning: "off" },
	eye: { id: "eye", provider: "test", model: "eye", reasoning: "off" },
	stale: {
		id: "stale",
		provider: "gone",
		model: "retired",
		reasoning: "off",
		maxOutputTokens: 99999,
	},
};

test("backend settings API validates only referenced profiles, vision capability and real agents", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-model-api-backend-"));
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
							catalog: () => catalog,
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
			settings?: { revision: number };
			error?: string;
		};
		if (response.status === 200 && body.settings)
			revision = body.settings.revision;
		return { status: response.status, body };
	};
	const base = () => ({
		profiles: [profiles.one, profiles.text, profiles.eye, profiles.stale],
		defaultProfileId: "one",
		roles: {},
		agentRoles: {},
	});
	try {
		// Unused stale profile (unknown model, over-limit budget) never blocks a save.
		expect((await patch(base())).status).toBe(200);
		expect(fleet.modelSettings.snapshot().revision).toBe(1);
		// Referencing it does.
		expect(
			(await patch({ ...base(), roles: { summary: "stale" } })).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					profiles: [
						{ ...profiles.one, maxOutputTokens: 5000 },
						profiles.text,
						profiles.eye,
						profiles.stale,
					],
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					profiles: [
						{ ...profiles.one, maxOutputTokens: 4096 },
						profiles.text,
						profiles.eye,
						profiles.stale,
					],
				})
			).status,
		).toBe(200);
		// Desired reasoning survives on non-reasoning models; host normalizes the call.
		expect(
			(
				await patch({
					...base(),
					profiles: [
						profiles.one,
						{ ...profiles.text, reasoning: "high" },
						profiles.eye,
						profiles.stale,
					],
					roles: { summary: "text" },
					roleReasoning: { summary: "medium", vision: "high" },
				})
			).status,
		).toBe(200);
		// Unauthenticated referenced model is rejected even without vision.
		expect((await patch({ ...base(), roles: { recall: "eye" } })).status).toBe(
			400,
		);
		// Vision bindings: explicit non-image model rejected, inherited text-only default allowed.
		expect((await patch({ ...base(), roles: { vision: "text" } })).status).toBe(
			400,
		);
		expect(
			(await patch({ ...base(), agentRoles: { lina: { vision: "text" } } }))
				.status,
		).toBe(400);
		expect((await patch({ ...base(), roles: { vision: "eye" } })).status).toBe(
			400,
		);
		expect((await patch({ ...base(), defaultProfileId: "text" })).status).toBe(
			200,
		);
		expect(
			(
				await patch({
					...base(),
					roles: { vision: "one" },
					agentRoles: { lina: { vision: "one" } },
				})
			).status,
		).toBe(200);
		// Agent keys must be real agents in both maps.
		expect(
			(await patch({ ...base(), agentRoles: { ghost: { summary: "one" } } }))
				.status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					agentRoleReasoning: { ghost: { summary: "low" } },
				})
			).status,
		).toBe(400);
		expect(
			(
				await patch({
					...base(),
					agentRoleReasoning: { lina: { summary: "low", vision: "off" } },
				})
			).status,
		).toBe(200);
		// Unknown field and invalid value never reach the store.
		expect(
			(await patch({ ...base(), roleReasoning: { summary: "max" } })).status,
		).toBe(400);
		expect((await patch({ ...base(), roleBudgets: {} })).status).toBe(400);
		const saved = fleet.modelSettings.snapshot();
		expect(saved.revision).toBe(revision);
		expect(saved.agentRoleReasoning).toEqual({
			lina: { summary: "low", vision: "off" },
		});
		const listing = (await (await fetch(url + "/api/models")).json()) as {
			catalog: CatalogModel[];
		};
		expect(listing.catalog.find((m) => m.id === "one")?.imageInput).toBe(true);
		// Activated tiers own internal models; preserved legacy references are dormant.
		const routed = {
			...base(),
			roles: { summary: "stale" },
			agentRoles: { lina: { reflection: "eye" } },
			routes: {
				version: 1,
				tiers: {
					quick: { profileId: "one" },
					standard: { profileId: "one" },
					deep: { profileId: "one" },
					intensive: { profileId: "one" },
				},
				roleTiers: {
					summary: "standard",
					observation: "quick",
					reflection: "deep",
					recall: "standard",
					vision: "standard",
				},
			},
		};
		expect((await patch(routed)).status).toBe(200);
		expect(fleet.modelSettings.snapshot().roles.summary).toBe("stale");
		expect(
			(await patch({ ...routed, roles: { conversation: "stale" } })).status,
		).toBe(400);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
