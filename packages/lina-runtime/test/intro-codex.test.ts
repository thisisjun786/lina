import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { checkpointCommand } from "../src/checkpoint-cli.ts";
import { startCodexFleet } from "../src/fleet/codex-fleet.ts";
import { introRoutes } from "../src/fleet/intro-routes.ts";

const resourceRoot = resolve(import.meta.dir, "../../..");
const body = (value: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(value),
});

test("offline checkpoints include introduction source and restore the same room", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-checkpoint-"));
	const home = join(root, "home");
	const options = {
		workspace: resourceRoot,
		stateRoot: join(home, "state"),
		port: 0,
		env: {},
		homeDir: root,
	};
	let app = await startCodexFleet(options);
	try {
		const url = `http://127.0.0.1:${app.port}/api/agents/lina/intro`;
		const snap = (await (
			await fetch(url, body({ kind: "user", mode: "fast" }))
		).json()) as { room: { id: string; revision: number } };
		const requestId = crypto.randomUUID();
		await fetch(
			`${url}/turn`,
			body({
				roomId: snap.room.id,
				revision: snap.room.revision,
				requestId,
				text: "체크포인트에 남을 원문",
			}),
		);
		const before = app.fleet.introductions.turns(snap.room.id);
		await app.stop();
		const saved = checkpointCommand("checkpoint", ["create", "intro source"], {
			LINA_HOME: home,
		}) as { id: string; files: { path: string }[] };
		expect(saved.files.some((f) => f.path === "introductions.sqlite")).toBe(
			true,
		);
		const target = join(root, "restored");
		checkpointCommand("restore", [saved.id, target], { LINA_HOME: home });
		app = await startCodexFleet({
			...options,
			stateRoot: join(target, "state"),
		});
		expect(app.fleet.introductions.turns(snap.room.id)).toEqual(before);
		expect(
			await (
				await fetch(`http://127.0.0.1:${app.port}/api/onboarding/entry`)
			).json(),
		).toMatchObject({ resume: { id: snap.room.id } });
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("shutdown cancels an in-flight introduction and persists its original request before releasing the installation lock", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-shutdown-"));
	const options = {
		workspace: resourceRoot,
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	};
	let app = await startCodexFleet(options);
	const entered = Promise.withResolvers<void>();
	try {
		const url = "http://localhost/api/agents/lina/intro";
		const start = { kind: "user", mode: "fast" };
		const response = await introRoutes(
			new Request(url, body(start)),
			app.fleet,
			async () => start,
		);
		const snap = (await response?.json()) as {
			room: { id: string; revision: number };
		};
		const control = app.fleet.managementModelControl();
		if (!control) throw Error("missing model control");
		control.authoring = async (_input, signal) => {
			entered.resolve();
			await new Promise<never>((_, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			);
			throw Error("unreachable");
		};
		const input = {
			roomId: snap.room.id,
			revision: snap.room.revision,
			requestId: crypto.randomUUID(),
			text: "원문 보존",
		};
		const pending = introRoutes(
			new Request(`${url}/turn`, body(input)),
			app.fleet,
			async () => input,
		);
		await entered.promise;
		expect(() => acquireInstallationLock(root)).toThrow();
		await app.stop();
		expect((await pending)?.status).toBe(499);
		app = await startCodexFleet(options);
		const turns = app.fleet.introductions.turns(snap.room.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			requestId: input.requestId,
			text: input.text,
			status: "failed",
			error: "cancelled",
		});
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("fresh offline Codex installation starts and resumes introductions without creating any session", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-lazy-"));
	let starts = 0;
	const options = {
		workspace: resourceRoot,
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
		createApp: async () => {
			starts++;
			throw Error("must stay lazy");
		},
	};
	let app = await startCodexFleet(options);
	try {
		let base = `http://127.0.0.1:${app.port}`;
		const entry = await fetch(`${base}/api/onboarding/entry`);
		expect(entry.status).toBe(200);
		expect(await entry.json()).toMatchObject({ firstUser: true, resume: null });
		const opened = await fetch(
			`${base}/api/agents/lina/intro`,
			body({ kind: "user", mode: "fast" }),
		);
		expect(opened.status).toBe(200);
		const snap = (await opened.json()) as {
			room: { id: string; revision: number };
		};
		const unavailable = await fetch(
			`${base}/api/agents/lina/intro/turn`,
			body({
				roomId: snap.room.id,
				revision: snap.room.revision,
				requestId: crypto.randomUUID(),
				text: null,
			}),
		);
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({ code: "not_configured" });
		expect(app.fleet.introductions.get(snap.room.id)?.revision).toBe(
			snap.room.revision,
		);
		expect(existsSync(join(root, "binding.json"))).toBe(false);
		expect(existsSync(join(root, "state.sqlite"))).toBe(false);
		await app.stop();
		app = await startCodexFleet(options);
		base = `http://127.0.0.1:${app.port}`;
		expect(
			await (await fetch(`${base}/api/onboarding/entry`)).json(),
		).toMatchObject({ firstUser: false, resume: { id: snap.room.id } });
		const birthId = crypto.randomUUID();
		const birth = { birthId, presetId: null, mode: "fast" };
		const born = await fetch(`${base}/api/agents/birth`, body(birth));
		expect(born.status).toBe(200);
		const result = await born.json();
		expect(
			await (await fetch(`${base}/api/agents/birth`, body(birth))).json(),
		).toEqual(result);
		expect(app.fleet.agents.list()).toHaveLength(2);
		expect(starts).toBe(0);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("lazy first-entry reads prior ordinary conversation without opening or rewriting it", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-existing-"));
	const db = new DatabaseSync(join(root, "state.sqlite"));
	db.exec(
		"CREATE TABLE entries(role TEXT); INSERT INTO entries VALUES ('user'); CREATE TABLE requests(status TEXT)",
	);
	db.close();
	const app = await startCodexFleet({
		workspace: resourceRoot,
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	});
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.port}/api/onboarding/entry`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			firstUser: false,
			resume: null,
		});
		expect(app.fleet.opened("lina")).toBeUndefined();
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("unknown or corrupt ordinary state never becomes a fresh first-entry", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-corrupt-"));
	writeFileSync(join(root, "state.sqlite"), "corrupt existing user data");
	const app = await startCodexFleet({
		workspace: resourceRoot,
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	});
	try {
		const response = await fetch(
			`http://127.0.0.1:${app.port}/api/onboarding/entry`,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ firstUser: false });
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("interrupted first selection resumes after restart and never creates a second agent", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-intro-choice-"));
	const options = {
		workspace: resourceRoot,
		stateRoot: root,
		port: 0,
		env: {},
		homeDir: root,
	};
	let app = await startCodexFleet(options);
	try {
		let base = `http://127.0.0.1:${app.port}`;
		const started = (await (
			await fetch(
				`${base}/api/agents/lina/intro`,
				body({ kind: "user", mode: "fast" }),
			)
		).json()) as {
			room: { id: string; revision: number };
			userRevision: number;
		};
		const finished = (await (
			await fetch(
				`${base}/api/agents/lina/intro/finish`,
				body({
					roomId: started.room.id,
					revision: started.room.revision,
					userRevision: started.userRevision,
					shareUser: false,
					skip: false,
				}),
			)
		).json()) as typeof started;
		const choose = {
			roomId: finished.room.id,
			revision: finished.room.revision,
			userRevision: finished.userRevision,
			birthId: crypto.randomUUID(),
			presetId: null,
			shareUser: true,
		};
		app.fleet.onboarding.saveUser = () => {
			throw Error("interrupted between agent create and sharing");
		};
		expect(
			(await fetch(`${base}/api/agents/lina/intro/choose`, body(choose)))
				.status,
		).toBe(400);
		expect(app.fleet.agents.list()).toHaveLength(2);
		await app.stop();
		app = await startCodexFleet(options);
		base = `http://127.0.0.1:${app.port}`;
		expect(
			await (await fetch(`${base}/api/onboarding/entry`)).json(),
		).toMatchObject({ resume: { id: finished.room.id } });
		expect(
			(await fetch(`${base}/api/agents/lina/intro/choose`, body(choose)))
				.status,
		).toBe(200);
		expect(app.fleet.agents.list()).toHaveLength(2);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
