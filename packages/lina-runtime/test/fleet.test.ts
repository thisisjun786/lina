import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import {
	initializeSessionFile,
	startTestApp as startPersistentApp,
} from "./fake-session-engine.ts";
import { ControlledSession } from "./runtime-fixture.ts";

test("fleet isolates fixed sessions and permits one active agent while another opens", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-fleet-test-"));
	const controls = new Map<string, ControlledSession>();
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: (options) =>
			startPersistentApp({
				...options,
				createSession: async (sdk) => {
					const identity = initializeSessionFile(
						sdk.sessionFile,
						sdk.workspace,
					);
					const session = new ControlledSession(
						identity.sessionId,
						identity.sessionFile,
					);
					controls.set(options.botId ?? "lina", session);
					return session;
				},
			}),
	});
	const server = await startFleetServer(fleet, 0, process.cwd());
	try {
		const socket = new WebSocket(`ws://127.0.0.1:${server.port}/`);
		const subscribed = Promise.withResolvers<void>();
		socket.onopen = () =>
			socket.send(JSON.stringify({ type: "subscribe", version: 2 }));
		socket.onmessage = (event) => {
			if (JSON.parse(String(event.data)).type === "snapshot")
				subscribed.resolve();
		};
		socket.onclose = () =>
			subscribed.reject(Error("Subscription closed before snapshot"));
		try {
			await subscribed.promise;
		} finally {
			socket.close();
		}
		const lina = await fleet.app("lina"),
			seed = fleet.presets.find((x) => x.id === "kai");
		if (!seed) throw Error("missing preset");
		fleet.agents.create(seed);
		const kai = await fleet.app("kai");
		expect(lina.binding.sessionId).not.toBe(kai.binding.sessionId);
		expect(lina.binding.sessionFile).not.toBe(kai.binding.sessionFile);
		const native = controls.get("lina");
		if (!native) throw Error("missing native");
		native.emit({ type: "agent_start" });
		native.user("owned-lina", "Lina private memory");
		expect(lina.runtime.snapshot().state).toBe("running");
		expect(kai.runtime.snapshot().messages).toEqual([]);
		expect(
			(await fleet.forSession(lina.binding.sessionId))?.binding.botId,
		).toBe("lina");
		const get = await fetch(`http://127.0.0.1:${server.port}/api/agents/lina`);
		expect(get.status).toBe(200);
		const blocked = await fetch(`http://127.0.0.1:${server.port}/api/agents`, {
			headers: { origin: "https://evil.test" },
		});
		expect(blocked.status).toBe(403);
		const stale = await fetch(
			`http://127.0.0.1:${server.port}/api/agents/lina`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ revision: 0, patch: { name: "wrong" } }),
			},
		);
		expect(stale.status).toBe(409);
		expect(fleet.agents.get("lina")?.name).toBe("리나");
		await native.abort();
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("forwards startup execution options to each owned app", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-fleet-options-"));
	let received: { approvalMode?: string } | undefined;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		approvalMode: "confirm",
		createApp: (options) => {
			received = options;
			return startPersistentApp({
				...options,
				createSession: async (sdk) => {
					const identity = initializeSessionFile(
						sdk.sessionFile,
						sdk.workspace,
					);
					return new ControlledSession(
						identity.sessionId,
						identity.sessionFile,
					);
				},
			});
		},
	});
	try {
		await fleet.app("lina");
		expect(received?.approvalMode).toBe("confirm");
	} finally {
		await fleet.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("honors selected primary agent and rejects unsafe avatar files", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-fleet-contract-"));
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: (options) =>
			startPersistentApp({
				...options,
				createSession: async (sdk) => {
					const identity = initializeSessionFile(
						sdk.sessionFile,
						sdk.workspace,
					);
					return new ControlledSession(
						identity.sessionId,
						identity.sessionFile,
					);
				},
			}),
	});
	try {
		const seed = fleet.presets.find((x) => x.id === "kai");
		if (!seed) throw Error("missing preset");
		fleet.agents.create(seed);
		const server = await startFleetServer(fleet, 0, process.cwd(), "kai");
		try {
			const health = await fetch(`http://127.0.0.1:${server.port}/health`);
			expect(((await health.json()) as { sessionId: string }).sessionId).toBe(
				(await fleet.app("kai")).binding.sessionId,
			);
			const hash = "a".repeat(64),
				avatars = join(root, "avatars");
			writeFileSync(join(avatars, "target.jpg"), Buffer.alloc(2_097_153));
			symlinkSync(join(avatars, "target.jpg"), join(avatars, `${hash}.jpg`));
			const unsafe = await fetch(
				`http://127.0.0.1:${server.port}/api/avatars/${hash}`,
			);
			expect(unsafe.status).toBe(400);
		} finally {
			await server.stop();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("retains fleet ownership when a child shutdown fails, then permits retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-fleet-shutdown-"));
	let attempts = 0;
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: async () =>
			({
				binding: { sessionId: "session", botId: "lina" },
				stop: async () => {
					attempts++;
					if (attempts === 1) throw new Error("child close failed");
				},
			}) as never,
	});
	try {
		await fleet.app("lina");
		await expect(fleet.close()).rejects.toThrow(/did not stop/);
		expect(fleet.agents.list()).toHaveLength(1);
		await fleet.close();
		await expect(fleet.app("lina")).rejects.toThrow(/closed/i);
	} finally {
		try {
			await fleet.close();
		} catch {}
		rmSync(root, { recursive: true, force: true });
	}
});

test("conversation profile uses its own revision and persists without changing core identity", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-conversation-api-")),
		fleet = new AgentFleet({
			createApp: startPersistentApp,
			workspace: process.cwd(),
			stateRoot: root,
			agentDir: join(root, "auth"),
			systemPrompt: "test",
		}),
		server = await startFleetServer(fleet, 0, process.cwd());
	const base = `http://127.0.0.1:${server.port}/api/agents/lina/conversation`;
	try {
		const get = await fetch(base);
		expect(get.status).toBe(200);
		const value = (await get.json()) as { profile: { revision: number } };
		const core = fleet.agents.get("lina");
		const patch = await fetch(base, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				revision: value.profile.revision,
				patch: { style: "차분한 대화" },
			}),
		});
		expect(patch.status).toBe(200);
		expect(((await patch.json()) as { style: string }).style).toBe(
			"차분한 대화",
		);
		expect(fleet.conversations.get("lina").examples.length).toBe(4);
		expect(fleet.agents.get("lina")).toEqual(core);
		expect(
			(
				await fetch(base, {
					method: "PATCH",
					body: JSON.stringify({
						revision: value.profile.revision,
						patch: { style: "stale" },
					}),
				})
			).status,
		).toBe(409);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("lazy fleet exposes hub and model setup even when no assistant can start", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-lazy-"));
	let started = 0;
	const modelControl = {
		catalog: () => [
			{
				provider: "opencodex",
				id: "test/model",
				name: "Model",
				contextWindow: 32000,
				maxOutputTokens: 2048,
				reasoning: false,
				authenticated: true,
			},
		],
		state: () => ({
			provider: "opencodex",
			model: "test/model",
			settingsRevision: 0,
			error: null,
		}),
		test: async () => ({
			provider: "opencodex",
			model: "test/model",
			text: "ok",
			durationMs: 0,
			inputTokens: 0,
			outputTokens: 0,
		}),
		authoring: async () => ({
			provider: "opencodex",
			model: "test/model",
			text: "draft",
		}),
	};
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "Lina",
		modelControl,
		createApp: async () => {
			started++;
			throw Error("model not configured");
		},
	});
	const server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
		lazy: true,
	});
	try {
		const health = await fetch(`http://127.0.0.1:${server.port}/health`);
		expect(health.status).toBe(200);
		expect(
			((await health.json()) as { sessionId: string | null }).sessionId,
		).toBeNull();
		const models = await fetch(`http://127.0.0.1:${server.port}/api/models`);
		expect(
			((await models.json()) as { catalog: { id: string }[] }).catalog[0]?.id,
		).toBe("test/model");
		expect(
			(
				await fleet.authoring(
					{ agentId: "lina", systemPrompt: "test", messages: [] },
					new AbortController().signal,
				)
			).text,
		).toBe("draft");
		expect(started).toBe(0);
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
