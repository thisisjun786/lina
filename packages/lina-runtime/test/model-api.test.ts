import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
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
