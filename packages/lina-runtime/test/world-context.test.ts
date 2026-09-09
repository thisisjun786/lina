import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import { WorldStore } from "../../lina-core/src/world/index.ts";
import { installPersona } from "../src/persona/hooks.ts";
import {
	activity,
	installTestWorldContext as installWorldContext,
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
	return fixture;
}
const signal = () => new AbortController().signal;

test("world binding and explicit limits are validated before installing hooks or tools", async () => {
	const { host: createHost, store } = fixture();
	for (const invalid of [
		{ worldId: "missing", agentId: "mina", limits },
		{ worldId: "island", agentId: "unknown", limits },
		{ worldId: "island", agentId: "mina", limits: { ...limits, maxChars: -1 } },
		{ worldId: "island", agentId: "mina", limits: { ...limits, maxFacts: -1 } },
		{
			worldId: "island",
			agentId: "mina",
			limits: { ...limits, maxEvents: 0.5 },
		},
	]) {
		const host = createHost();
		expect(() =>
			installWorldContext(host.asLinaHost(), { store, ...invalid }),
		).toThrow();
		expect(host.tools.size).toBe(0);
		expect(
			await host.emit("context", { messages: [] }, signal()),
		).toBeUndefined();
	}
});

test("world context refreshes shared facts and keeps private facts and events agent-scoped", async () => {
	const { store, host: createHost } = fixture();
	const mina = createHost(),
		rumi = createHost();
	for (const [host, agentId] of [
		[mina, "mina"],
		[rumi, "rumi"],
	] as const)
		installWorldContext(host.asLinaHost(), {
			store,
			worldId: "island",
			agentId,
			limits,
		});
	const before = await rumi.emit("context", { messages: [] }, signal());
	expect(JSON.stringify(before)).toContain("harbor bell");
	expect(JSON.stringify(before)).not.toContain("blue key");
	expect(JSON.stringify(before)).not.toContain("red boat");
	store.accept(activity());
	store.accept(
		activity({
			idempotencyKey: "private-discovery",
			expectedRevision: 1,
			simulationTime: 2,
			actorIds: ["mina"],
			audience: ["mina"],
			summary: "Mina finds a hidden map",
			facts: [{ id: "map", text: "The map points north", knownTo: ["mina"] }],
		}),
	);
	const minaContext = JSON.stringify(
		await mina.emit("context", { messages: [] }, signal()),
	);
	const rumiContext = JSON.stringify(
		await rumi.emit("context", { messages: [] }, signal()),
	);
	for (const content of [minaContext, rumiContext]) {
		expect(content).toContain("The boat is red");
		expect(content).toContain("A red boat arrives");
		expect(content).toContain("fictional");
		expect(content).toContain("reference");
	}
	expect(minaContext).toContain("hidden map");
	expect(minaContext).toContain("blue key");
	expect(rumiContext).not.toContain("hidden map");
	expect(rumiContext).not.toContain("points north");
	expect(rumiContext).not.toContain("blue key");
});

test("each context event replaces every old world block and preserves other messages", async () => {
	const { store, host: createHost } = fixture();
	const host = createHost();
	installWorldContext(host.asLinaHost(), {
		store,
		worldId: "island",
		agentId: "rumi",
		limits,
	});
	const user = { role: "user", content: "hello" };
	const memory = {
		role: "custom",
		customType: "lina-context-reference",
		content: "real memory",
	};
	const stale = {
		role: "custom",
		customType: "lina-world-reference",
		content: "stale secret",
	};
	const messages = [stale, memory, user, stale];
	const first = (await host.emit("context", { messages }, signal())) as {
		messages: unknown[];
	};
	const second = (await host.emit("context", first, signal())) as {
		messages: unknown[];
	};
	expect(second.messages).toHaveLength(3);
	expect(second.messages.slice(1)).toEqual([memory, user]);
	expect(JSON.stringify(second)).not.toContain("stale secret");
	expect(messages).toEqual([stale, memory, user, stale]);
	expect(second.messages[0]).toMatchObject({
		role: "custom",
		customType: "lina-world-reference",
		display: false,
	});
});

test("world read tool has no selectors, reads fresh scoped data, and never mutates the world", async () => {
	const { store, host: createHost } = fixture();
	const host = createHost();
	installWorldContext(host.asLinaHost(), {
		store,
		worldId: "island",
		agentId: "rumi",
		limits,
	});
	expect([...host.tools.keys()]).toEqual(["lina_world_read"]);
	expect(host.tools.get("lina_world_read")?.parameters).toMatchObject({
		type: "object",
		properties: {},
		additionalProperties: false,
	});
	store.accept(activity());
	const before = store.snapshot("island");
	const read = await host.invokeTool("lina_world_read", "read-1", {}, signal());
	expect(read.success).toBe(true);
	const text = read.contentItems.map((item) => item.text).join("\n");
	expect(text).toContain("The boat is red");
	expect(text).toContain("rumi");
	expect(text).not.toContain("blue key");
	for (const input of [
		{ agentId: "mina" },
		{ worldId: "other" },
		{ limits: { maxChars: 100000 } },
	])
		await expect(
			host.invokeTool("lina_world_read", "bad", input, signal()),
		).rejects.toThrow("Invalid tool arguments");
	expect(store.snapshot("island")).toEqual(before);
});

test("world events and restart preserve identity bytes, dynamics, and authored system prompt", async () => {
	const { root, path, store, host: createHost } = fixture();
	const agentsPath = join(root, "agents.sqlite");
	const agents = new AgentStore(agentsPath);
	cleanups.push(() => agents.close());
	agents.create({
		id: "mina",
		name: "Mina",
		role: "Navigator",
		personality: "Curious",
		voice: "Plain",
		profile: "  Authored identity\nwith exact spacing.\n",
		appearance: "An authored green coat",
		interests: ["stars"],
		avatarId: null,
		evolution: "manual",
	});
	const host = createHost();
	installPersona(
		host.asLinaHost(),
		agents,
		"mina",
		"Authored base\n",
		worldServices(),
	);
	const authored = (await host.beforeTurn("hello", signal())).systemPrompt;
	const profile = JSON.stringify(agents.get("mina"));
	const dynamics = JSON.stringify(agents.dynamics("mina"));
	// A closed/checkpointed baseline lets us compare the actual database bytes.
	agents.close();
	const originalBytes = readFileSync(agentsPath);
	const reopenedAgents = new AgentStore(agentsPath);
	cleanups.push(() => reopenedAgents.close());
	const active = createHost();
	installPersona(
		active.asLinaHost(),
		reopenedAgents,
		"mina",
		"Authored base\n",
		worldServices(),
	);
	installWorldContext(active.asLinaHost(), {
		store,
		worldId: "island",
		agentId: "mina",
		limits,
	});
	store.accept(activity());
	await active.emit("context", { messages: [] }, signal());
	expect((await active.beforeTurn("again", signal())).systemPrompt).toBe(
		authored,
	);
	expect(JSON.stringify(reopenedAgents.get("mina"))).toBe(profile);
	expect(JSON.stringify(reopenedAgents.dynamics("mina"))).toBe(dynamics);
	expect(reopenedAgents.changes("mina")).toEqual([]);
	reopenedAgents.close();
	expect(readFileSync(agentsPath)).toEqual(originalBytes);
	store.close();
	const restored = new WorldStore(path);
	cleanups.push(() => restored.close());
	const restoredAgents = new AgentStore(agentsPath);
	cleanups.push(() => restoredAgents.close());
	const restarted = createHost();
	installPersona(
		restarted.asLinaHost(),
		restoredAgents,
		"mina",
		"Authored base\n",
		worldServices(),
	);
	installWorldContext(restarted.asLinaHost(), {
		store: restored,
		worldId: "island",
		agentId: "mina",
		limits,
	});
	expect((await restarted.beforeTurn("resumed", signal())).systemPrompt).toBe(
		authored,
	);
	expect(
		JSON.stringify(await restarted.emit("context", { messages: [] }, signal())),
	).toContain("The boat is red");
	expect(JSON.stringify(restoredAgents.get("mina"))).toBe(profile);
	restoredAgents.close();
	expect(readFileSync(agentsPath)).toEqual(originalBytes);
});

test("Codex beforeTurn carries world reference outside authored instructions", async () => {
	const { store, host: createHost } = fixture();
	const host = createHost();
	installWorldContext(host.asLinaHost(), {
		store,
		worldId: "island",
		agentId: "rumi",
		limits,
	});
	const turn = await host.beforeTurn("hello", signal());
	expect(turn.systemPrompt).toBeUndefined();
	expect(turn.context).toContain("harbor bell");
	expect(turn.context).not.toContain("blue key");
});

test("world installation captures binding and explicit budgets without caller mutation", async () => {
	const { store, host: createHost } = fixture();
	const host = createHost();
	const options = {
		store,
		worldId: "island",
		agentId: "rumi",
		limits: { maxChars: 1000, maxFacts: 0, maxEvents: 0 },
	};
	installWorldContext(host.asLinaHost(), options);
	options.agentId = "mina";
	options.worldId = "unknown";
	options.limits.maxFacts = 20;
	options.limits.maxEvents = 10;
	store.accept(activity());
	const tool = host.tools.get("lina_world_read");
	if (!tool) throw Error("World tool was not registered");
	const result = await tool.execute("bounded", {}, signal());
	expect(result.details).toMatchObject({
		worldId: "island",
		agentId: "rumi",
		revision: 1,
		facts: [],
		events: [],
		truncated: true,
	});
	expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(1000);
});

test("Codex composes world reference with the preceding context hook", async () => {
	const { store, host: createHost } = fixture();
	const host = createHost();
	host.asLinaHost().on("context", (event) => ({
		messages: [
			{
				role: "custom",
				customType: "lina-context-reference",
				content: "An independent working-state reference",
				display: false,
				timestamp: 0,
			},
			...event.messages,
		],
	}));
	installWorldContext(host.asLinaHost(), {
		store,
		worldId: "island",
		agentId: "rumi",
		limits,
	});
	const result = await host.emit("context", { messages: [] }, signal());
	expect(JSON.stringify(result)).toContain(
		"independent working-state reference",
	);
	expect(JSON.stringify(result)).toContain("harbor bell");
	const turn = await host.beforeTurn("hello", signal());
	expect(turn.context).toContain("independent working-state reference");
	expect(turn.context).toContain("harbor bell");
});
