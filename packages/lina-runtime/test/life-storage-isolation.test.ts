import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import { AgentFleet } from "../src/fleet/manager.ts";
import { startFleetServer } from "../src/fleet/server.ts";
import type { AppOptions } from "../src/session-app.ts";
import { startPersistentApp } from "../src/session-app.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import { lifeAcceptanceFixture } from "./life-acceptance-fixture.ts";
import { ControlledSession } from "./runtime-fixture.ts";

const healthPath = "/api/life/health";
test("cold LIFE health never opens a database, scheduler or provider", async () => {
	const { f } = await lifeAcceptanceFixture({
		createImageClient: () => {
			throw Error("Cold health must not create image provider");
		},
	});
	try {
		const url = `http://127.0.0.1:${f.app.port}${healthPath}`;
		const response = await fetch(url);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ state: "unopened" });
		expect((await fetch(url, { method: "POST" })).status).toBe(405);
		expect((await fetch(url + "?world=private")).status).toBe(400);
		expect(
			(await fetch(url, { headers: { Origin: "https://invalid.example" } }))
				.status,
		).toBe(403);
		expect(existsSync(join(f.root, "state", "life"))).toBe(false);
		expect(f.models).toHaveLength(0);
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test("a rejected LIFE file preserves bound-agent chat and tasks without reopening or rewriting it", async () => {
	let source: AppOptions["world"];
	const engine = testSessionEngine();
	const { f, rpc } = await lifeAcceptanceFixture({
		createApp: (input) => {
			source = input.world;
			return startPersistentApp({ ...input, engine });
		},
	});
	try {
		f.setup();
		f.app.fleet.lifeStorage.setWorldBinding("lina", 0, {
			version: 2,
			worldId: "test-world",
			projectionPolicyRevision: 1,
			conversationRecipientId: null,
		});
		await f.app.stop();
		const dir = join(f.root, "state", "life"),
			file = join(dir, "world.sqlite");
		const raw = new DatabaseSync(file);
		raw.exec(
			"UPDATE worlds SET state_json=json_set(state_json,'$.simulationTime',999)",
		);
		raw.close();
		// A cold process has no closed native statements awaiting finalization.
		Bun.gc(true);
		const before = readFileSync(file),
			listing = readdirSync(dir).sort();
		await f.restart();
		const response = await fetch(`http://127.0.0.1:${f.app.port}${healthPath}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			state: "rejected",
			code: "LIFE_STORAGE_UNAVAILABLE",
		});
		const chat = await f.app.fleet.app("lina");
		expect(typeof source).toBe("function");
		if (typeof source !== "function")
			throw Error("Missing ordinary world callback");
		expect(source()).toBeUndefined();
		const native = chat.runtime.native;
		if (!(native instanceof ControlledSession))
			throw Error("Missing controlled ordinary session");
		const entered = Promise.withResolvers<string>();
		native.onPrompt = async (text, admission) => {
			admission.disposition("started");
			entered.resolve(text);
		};
		chat.runtime.submit(
			"ordinary-after-corruption",
			"ordinary chat still works",
		);
		expect(await entered.promise).toContain("ordinary chat still works");
		await chat.runtime.cancel("ordinary-after-corruption");
		const task = await f.app.tasks.create({
			ownerAgentId: "lina",
			title: "Unrelated work",
			cwd: f.root,
			prompt: "ordinary task",
			requestId: "task-after-life-rejection",
		});
		expect(task.threadId).toBeTruthy();
		if (!task.threadId) throw Error("Task did not start");
		const completed = Promise.withResolvers<void>(),
			off = f.app.tasks.subscribeWork(() => completed.resolve());
		rpc.completeTurn(task.threadId);
		await completed.promise;
		off();
		expect(f.app.tasks.workReceipts(task.id)).toHaveLength(1);
		const management = await fetch(
			`http://127.0.0.1:${f.app.port}/api/life/worlds`,
		);
		expect(management.status).toBe(503);
		expect(await management.json()).toEqual({
			error: "World author engine unavailable",
		});
		expect(source()).toBeUndefined();
		expect(readFileSync(file)).toEqual(before);
		expect(readdirSync(dir).sort()).toEqual(listing);
		expect(() => new WorldStore(file)).toThrow();
		expect(f.providerCalls).toBe(0);
	} finally {
		await f.close();
	}
});

test("a loopback reader without installation ownership cannot inspect LIFE health", async () => {
	const root = mkdtempSync(join(tmpdir(), "life-health-nonowner-"));
	const fleet = new AgentFleet({
		workspace: process.cwd(),
		stateRoot: root,
		agentDir: join(root, "auth"),
		systemPrompt: "test",
		createApp: async () => {
			throw Error("Health must not open chat");
		},
	});
	let server: Awaited<ReturnType<typeof startFleetServer>> | undefined;
	try {
		server = await startFleetServer(fleet, 0, process.cwd(), "lina", {
			lazy: true,
		});
		expect(
			(await fetch(`http://127.0.0.1:${server.port}/api/life/health`)).status,
		).toBe(403);
		expect(existsSync(join(root, "life"))).toBe(false);
	} finally {
		await server?.stop();
		await fleet.close();
		rmSync(root, { recursive: true, force: true });
	}
});
