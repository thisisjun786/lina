import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodexHost } from "../../lina-codex/src/host.ts";
import type { SdkSessionOptions } from "../src/host.ts";
import { type AppOptions, startPersistentApp } from "../src/session-app.ts";
import { testSessionEngine } from "./fake-session-engine.ts";
import {
	activity,
	limits,
	worldFixture,
	worldServices,
} from "./world-fixture.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
	const fixture = worldFixture();
	cleanups.push(fixture.close);
	const engine = testSessionEngine();
	const hosts: CodexHost[] = [];
	const options: AppOptions = {
		engine,
		workspace: fixture.root,
		stateRoot: join(fixture.root, "state"),
		agentDir: join(fixture.root, "auth"),
		botId: "rumi",
		systemPrompt: "Authored instructions",
		memoryBackend: "disabled",
		port: 0,
		createSession: async (options: SdkSessionOptions) => {
			const host = fixture.host();
			hosts.push(host);
			options.register?.(host.asLinaHost(), worldServices(), () => ({
				action: "allow",
			}));
			return engine.create(options);
		},
	};
	return { ...fixture, options, hosts };
}

test("persistent app world option binds actual bot ID and leaves shared store open through restart", async () => {
	const { options, store, hosts } = fixture();
	options.world = { store, worldId: "island", limits };
	const app = await startPersistentApp(options);
	cleanups.push(app.stop);
	const first = hosts[0];
	if (!first) throw Error("Session host was not created");
	expect(first.tools.has("lina_world_read")).toBe(true);
	const tool = first.tools.get("lina_world_read");
	if (!tool) throw Error("World tool was not registered");
	const read = await tool.execute(
		"world-read",
		{},
		new AbortController().signal,
	);
	expect(JSON.stringify(read)).toContain("harbor bell");
	expect(JSON.stringify(read)).not.toContain("blue key");
	const before = await first.beforeTurn("hello", new AbortController().signal);
	expect(before.systemPrompt ?? "").not.toContain("harbor bell");
	await app.stop();
	store.accept(activity());
	const resumed = await startPersistentApp(options);
	cleanups.push(resumed.stop);
	expect(resumed.binding.sessionId).toBe(app.binding.sessionId);
	const next = hosts[1];
	if (!next) throw Error("Resumed host was not created");
	const turn = await next.beforeTurn(
		"after restart",
		new AbortController().signal,
	);
	const reference = await next.emit(
		"context",
		{ messages: [] },
		new AbortController().signal,
	);
	expect(JSON.stringify(reference)).toContain("The boat is red");
	expect(JSON.stringify(reference)).not.toContain("blue key");
	expect(turn.systemPrompt).toBe(before.systemPrompt);
	expect(resumed.runtime.store.history().messages).toEqual([]);
	await resumed.stop();
	expect(store.snapshot("island").revision).toBe(1);
});

test("persistent app delivers the world reference through Codex beforeTurn", async () => {
	const { options, store, hosts } = fixture();
	options.world = { store, worldId: "island", limits };
	const app = await startPersistentApp(options);
	cleanups.push(app.stop);
	const host = hosts[0];
	if (!host) throw Error("Session host was not created");
	const turn = await host.beforeTurn("hello", new AbortController().signal);
	expect(turn.context).toContain("harbor bell");
	expect(turn.context).not.toContain("blue key");
	expect(turn.systemPrompt ?? "").not.toContain("harbor bell");
});

test("world is absent unless explicitly enabled", async () => {
	const { options, hosts, store } = fixture();
	const app = await startPersistentApp(options);
	cleanups.push(app.stop);
	const host = hosts[0];
	if (!host) throw Error("Session host was not created");
	expect(host.tools.has("lina_world_read")).toBe(false);
	const turn = await host.beforeTurn("hello", new AbortController().signal);
	expect(turn.context ?? "").not.toContain("harbor bell");
	expect(store.snapshot("island").revision).toBe(0);
});

test("invalid world startup fails before engine initialization or local session writes", async () => {
	const { options, store, hosts } = fixture();
	let initialized = false;
	options.engine = {
		...options.engine,
		initialize: () => {
			initialized = true;
			throw Error("Unexpected engine initialization");
		},
	};
	options.world = { store, worldId: "missing", limits };
	await expect(startPersistentApp(options)).rejects.toThrow();
	expect(initialized).toBe(false);
	expect(hosts).toEqual([]);
	expect(existsSync(options.stateRoot)).toBe(false);
});
