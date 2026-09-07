import { afterEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type WorldContext,
	WorldStore,
} from "../../lina-core/src/world/index.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import { installWorldContext } from "../../lina-runtime/src/world.ts";
import {
	COMPANION_MODEL,
	createCompanionRpc,
} from "../../lina-runtime/test/helpers/companion-codex-rpc.ts";
import {
	activity,
	limits,
	worldAccess,
	worldFixture,
	worldServices,
} from "../../lina-runtime/test/world-fixture.ts";
import { createCodexSession } from "../src/session.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const AUTHORED = "  Authored character identity: 미나\nKeep this spacing.\n";
const models: ModelControl = {
	catalog: () => [],
	state: () => ({
		provider: "synthetic",
		model: COMPANION_MODEL,
		settingsRevision: 1,
		error: null,
	}),
	test: async () => {
		throw Error("Unexpected model probe");
	},
};

async function open(root: string, store: WorldStore, agentId: string) {
	const workspace = join(root, agentId);
	mkdirSync(workspace, { recursive: true });
	const rpc = createCompanionRpc(workspace);
	const access = worldAccess(agentId);
	const policy = access.currentContextPolicy();
	cleanup.push(() => rpc.close());
	const session = await createCodexSession({
		workspace,
		sessionFile: join(workspace, "session.jsonl"),
		agentDir: join(workspace, "auth"),
		agentId,
		systemPrompt: "A distinct base prompt",
		contextPolicy: policy,
		currentContextPolicy: access.currentContextPolicy,
		contextExposure: (source) =>
			source.kind === "bootstrap"
				? []
				: [
						{
							kind: "disclosed-life",
							sourceId: `island:${agentId}:revision:${store.snapshot("island").revision}`,
						},
					],
		services: worldServices(),
		models,
		rpc: rpc.options,
		register(host) {
			host.on("before_agent_start", () => ({ systemPrompt: AUTHORED }));
			host.on("context", (event) => ({
				messages: [
					{
						role: "custom",
						customType: "lina-context-reference",
						display: false,
						content: `Existing conversation context for ${agentId}`,
						timestamp: 0,
					},
					...event.messages,
				],
			}));
			installWorldContext(host, {
				store,
				worldId: "island",
				agentId,
				limits,
				...access,
			});
		},
	});
	cleanup.push(() => session.close());
	return { session, rpc };
}

async function turn(client: Awaited<ReturnType<typeof open>>, text: string) {
	const pending = client.session.prompt(text, {
		signal: new AbortController().signal,
		disposition() {},
		rejected() {
			throw Error("Unexpected prompt rejection");
		},
	});
	const outgoing = await client.rpc.nextTurn();
	client.rpc.complete(outgoing);
	await pending;
	expect(outgoing.params["input"]).toEqual([
		{ type: "text", text, text_elements: [] },
	]);
	return outgoing.params;
}

function worldFromRequest(
	params: Record<string, unknown>,
	agentId: string,
): WorldContext {
	// Read the serialized RPC request captured by the fake server, not the host result.
	const additional = params["additionalContext"] as Record<
		string,
		{ kind: string; value: string }
	>;
	expect(Object.keys(additional)).toEqual(["lina-context-reference"]);
	const reference = additional["lina-context-reference"];
	if (!reference) throw Error("Missing outgoing world reference");
	expect(reference.kind).toBe("untrusted");
	expect(reference.value).toContain(
		`Existing conversation context for ${agentId}`,
	);
	expect(reference.value).not.toContain(AUTHORED);
	const json = reference.value.split("\n").find((line) => line.startsWith("{"));
	if (!json) throw Error("Missing serialized world context");
	const world: WorldContext = JSON.parse(json);
	expect(world).toMatchObject({
		worldId: "island",
		agentId,
		origin: "fictional",
	});
	return world;
}

function instructions(client: Awaited<ReturnType<typeof open>>): string[] {
	return client.rpc.requests
		.filter((request) => request.method === "thread/inject_items")
		.map((request) => {
			const items = request.params["items"] as Array<{
				role: string;
				content: Array<{ type: string; text: string }>;
			}>;
			expect(items).toHaveLength(1);
			const item = items[0];
			if (!item) throw Error("Missing instruction item");
			expect(item.role).toBe("developer");
			expect(item.content).toHaveLength(1);
			const content = item.content[0];
			if (!content) throw Error("Missing instruction content");
			expect(content.type).toBe("input_text");
			expect(content.text.endsWith(AUTHORED)).toBe(true);
			expect(content.text).not.toContain("blue key");
			expect(content.text).not.toContain("harbor bell");
			expect(content.text).not.toContain("boat");
			return content.text;
		});
}

test("actual turn/start requests keep world references untrusted, agent-scoped and fresh without changing instructions", async () => {
	const fixture = worldFixture();
	cleanup.push(fixture.close);
	const mina = await open(fixture.root, fixture.store, "mina");
	expect(mina.session.nativeEpoch).toBe(1);
	const rumi = await open(fixture.root, fixture.store, "rumi");
	const initialMina = worldFromRequest(
		await turn(mina, "Mina first request"),
		"mina",
	);
	const initialRumi = worldFromRequest(
		await turn(rumi, "Rumi first request"),
		"rumi",
	);
	expect(initialMina.revision).toBe(0);
	expect(initialRumi.revision).toBe(0);
	expect(initialMina.facts.map((fact) => fact.text)).toContain(
		"Mina hides a blue key",
	);
	expect(initialRumi.facts.map((fact) => fact.text)).toEqual([
		"The harbor bell rings at dawn",
	]);
	const originalInstructions = instructions(rumi);
	expect(originalInstructions).toHaveLength(1);
	const accepted = fixture.store.accept(activity());
	const privateEvent = fixture.store.accept(
		activity({
			idempotencyKey: "mina-private-event",
			expectedRevision: 1,
			simulationTime: 2,
			actorIds: ["mina"],
			audience: ["mina"],
			summary: "Mina studies a sealed chart",
			facts: [],
		}),
	);
	const nextMina = worldFromRequest(
		await turn(mina, "Mina next request"),
		"mina",
	);
	const nextRumi = worldFromRequest(
		await turn(rumi, "Rumi next request"),
		"rumi",
	);
	for (const world of [nextMina, nextRumi]) {
		expect(world.revision).toBe(2);
		expect(world.facts).toContainEqual({
			id: "boat",
			text: "The boat is red",
			sourceEventId: accepted.event.id,
		});
		expect(world.events).toContainEqual(
			expect.objectContaining({
				id: accepted.event.id,
				summary: "A red boat arrives",
			}),
		);
	}
	expect(nextMina.events).toContainEqual(
		expect.objectContaining({
			id: privateEvent.event.id,
			summary: "Mina studies a sealed chart",
		}),
	);
	expect(JSON.stringify(nextRumi)).not.toContain("blue key");
	expect(JSON.stringify(nextRumi)).not.toContain("sealed chart");
	expect(nextRumi.events).toHaveLength(1);
	expect(instructions(rumi)).toEqual(originalInstructions);
	expect(instructions(mina)).toEqual(originalInstructions);
});

test("reopening world and Codex session restores scoped reference on the same thread with authored instructions intact", async () => {
	const fixture = worldFixture();
	cleanup.push(fixture.close);
	const first = await open(fixture.root, fixture.store, "rumi");
	const initial = worldFromRequest(await turn(first, "Before close"), "rumi");
	expect(initial.revision).toBe(0);
	const originalInstructions = instructions(first);
	const sessionId = first.session.sessionId;
	const threadId = first.session.threadId;
	fixture.store.accept(activity());
	await first.session.close();
	first.rpc.close();
	fixture.store.close();
	const reopenedWorld = new WorldStore(fixture.path);
	cleanup.push(() => reopenedWorld.close());
	const resumed = await open(fixture.root, reopenedWorld, "rumi");
	expect(resumed.session.sessionId).toBe(sessionId);
	expect(resumed.session.threadId).toBe(threadId);
	expect(resumed.session.nativeEpoch).toBe(1);
	expect(
		resumed.session
			.contextLineage()
			.some((receipt) =>
				receipt.materials.some(
					(material) => material.sourceId === "island:rumi:revision:0",
				),
			),
	).toBe(true);
	const methods = resumed.rpc.requests.map((request) => request.method);
	expect(methods).toContain("thread/resume");
	expect(methods).not.toContain("thread/start");
	const restored = worldFromRequest(
		await turn(resumed, "After reopen"),
		"rumi",
	);
	expect(restored.revision).toBe(1);
	expect(restored.facts.map((fact) => fact.text)).toEqual([
		"The harbor bell rings at dawn",
		"The boat is red",
	]);
	expect(restored.events).toHaveLength(1);
	expect(restored.events[0]?.summary).toBe("A red boat arrives");
	expect(JSON.stringify(restored)).not.toContain("blue key");
	expect(instructions(resumed)).toEqual(originalInstructions);
	expect(reopenedWorld.snapshot("island").revision).toBe(1);
});
