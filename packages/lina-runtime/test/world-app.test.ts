import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CodexHost } from "../../lina-codex/src/host.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
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

test("installed world configuration is refused before unguarded collectors or session writes", async () => {
	const { options, store, hosts } = fixture();
	options.world = { store, worldId: "island", limits };
	let initialized = false;
	options.engine = {
		...options.engine,
		initialize: () => {
			initialized = true;
			throw Error("Unexpected engine initialization");
		},
	};
	await expect(startPersistentApp(options)).rejects.toThrow("source-aware");
	expect(initialized).toBe(false);
	expect(hosts).toEqual([]);
	expect(existsSync(options.stateRoot)).toBe(false);
	// Rejecting activation does not take ownership of or mutate the caller's world.
	store.accept(activity());
	expect(store.snapshot("island").revision).toBe(1);
});

test("ordinary bootstrap exposes current authored persona through the pure registered compiler", async () => {
	const { options, root } = fixture();
	const agents = new AgentStore(join(root, "agents.sqlite"));
	cleanups.push(() => agents.close());
	agents.create({
		id: "rumi",
		name: "Rumi",
		role: "Navigator",
		personality: "Curious",
		voice: "Plain",
		profile: "Exact authored identity for bootstrap",
		appearance: "A green coat",
		interests: ["stars"],
		avatarId: null,
		evolution: "manual",
	});
	options.persona = { agents, agentId: "rumi" };
	let captured: SdkSessionOptions | undefined;
	const create = options.createSession;
	if (!create) throw Error("Missing fixture session factory");
	options.createSession = async (input) => {
		const session = await create(input);
		captured = input;
		return session;
	};
	const app = await startPersistentApp(options);
	cleanups.push(app.stop);
	expect(typeof captured?.bootstrapInstructions).toBe("function");
	expect(captured?.bootstrapInstructions?.()).toContain("Personality: Curious");
	expect(captured?.bootstrapInstructions?.()).toContain("Navigator");
	// Biography is reference data; bootstrap reuses the authored behavior compiler.
	expect(captured?.bootstrapInstructions?.()).not.toContain(
		"Exact authored identity for bootstrap",
	);
	agents.update("rumi", 1, { personality: "Careful authored curiosity" });
	expect(captured?.bootstrapInstructions?.()).toContain(
		"Careful authored curiosity",
	);
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
