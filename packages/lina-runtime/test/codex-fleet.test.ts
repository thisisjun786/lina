import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";

test("owned task failure while Hub is offline preserves the engine binding across restart", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-owned-offline-"));
	const options = {
		workspace: resolve(import.meta.dir, "../../.."),
		stateRoot: root,
		port: 0,
		homeDir: root,
		env: {},
	};
	let app = await startCodexFleet({ ...options, defaultTaskMode: "owned" });
	try {
		await expect(
			app.tasks.create({
				ownerAgentId: "lina",
				title: "offline",
				cwd: root,
				prompt: "fixture",
				requestId: "offline-fixture",
			}),
		).rejects.toThrow("OpenCodex Hub is unavailable");
		const ids = app.tasks.list().map((task) => task.id);
		expect(ids).toHaveLength(1);
		await app.stop();
		app = await startCodexFleet({ ...options, defaultTaskMode: "shared" });
		expect(app.tasks.list().map((task) => task.id)).toEqual(ids);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent shutdown calls keep the installation locked until all writers stop", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-stop-lock-"));
	const app = await startCodexFleet({
		workspace: resolve(import.meta.dir, "../../.."),
		stateRoot: root,
		port: 0,
		homeDir: root,
		env: {},
	});
	const gate = Promise.withResolvers<void>();
	const closeTasks = app.tasks.close.bind(app.tasks);
	app.tasks.close = async () => {
		await gate.promise;
		await closeTasks();
	};
	const first = app.stop(),
		second = app.stop();
	try {
		await Promise.resolve();
		await Promise.resolve();
		expect(() => acquireInstallationLock(root)).toThrow();
	} finally {
		gate.resolve();
		await Promise.all([first, second]);
		rmSync(root, { recursive: true, force: true });
	}
});

test("default Codex fleet serves offline Hub/settings before any assistant or shared daemon starts", async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "lina-codex-fleet-"));
	let starts = 0;
	const app = await startCodexFleet({
		workspace: resolve(import.meta.dir, "../../.."),
		stateRoot,
		port: 0,
		env: {},
		homeDir: stateRoot,
		createApp: async () => {
			starts++;
			throw Error("assistant must stay lazy");
		},
	});
	try {
		const base = `http://127.0.0.1:${app.port}`;
		expect(
			((await (await fetch(`${base}/health`)).json()) as { sessionId: unknown })
				.sessionId,
		).toBeNull();
		const hub = (await (await fetch(`${base}/api/hub/status`)).json()) as {
			configured: boolean;
		};
		expect(hub.configured).toBe(false);
		const tasks = await (await fetch(`${base}/api/tasks`)).json();
		expect(tasks).toEqual({ tasks: [] });
		expect((await fetch(`${base}/api/models`)).status).toBe(200);
		expect(starts).toBe(0);
	} finally {
		await app.stop();
		rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("installed fleet reads packaged personas while agents receive independent working directories", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-installed-fleet-"));
	const workspaceRoot = join(root, "workspaces");
	mkdirSync(workspaceRoot);
	const observed: string[] = [];
	const app = await startCodexFleet({
		workspace: workspaceRoot,
		workspaceRoot,
		resourceRoot: resolve(import.meta.dir, "../../.."),
		stateRoot: join(root, "state"),
		port: 0,
		homeDir: root,
		env: {},
		createApp: async (options) => {
			observed.push(options.workspace);
			throw Error("captured start");
		},
	});
	try {
		await expect(app.fleet.app("lina")).rejects.toThrow("captured start");
		const seed = app.fleet.presets[0];
		if (!seed) throw Error("missing test persona");
		app.fleet.agents.create({ ...seed, id: "second" });
		await expect(app.fleet.app("second")).rejects.toThrow("captured start");
		expect(observed).toEqual([
			join(workspaceRoot, "lina"),
			join(workspaceRoot, "second"),
		]);
		expect(
			(await fetch(`http://127.0.0.1:${app.port}/api/agents`)).status,
		).toBe(200);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
