import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createCodexSession } from "../../lina-codex/src/session.ts";
import { AgentStore } from "../../lina-core/src/agents/store.ts";
import {
	identityPolicy,
	lifeDefinition,
	socialCommit,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { createSessionContextPolicy } from "../src/context-policy.ts";
import { installPersona } from "../src/persona/hooks.ts";
import { installWorldContext } from "../src/world.ts";
import {
	COMPANION_MODEL,
	createCompanionRpc,
} from "./helpers/companion-codex-rpc.ts";
import { limits, worldFixture, worldServices } from "./world-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

test.each(["conversation", "life"] as const)(
	"accepted LIFE state reaches serialized %s requests and survives session reopen with authored identity intact",
	async (purpose) => {
		const world = worldFixture();
		cleanup.push(world.close);
		world.store.create(worldDefinition());
		world.store.prepareLife(lifeDefinition());
		world.store.acceptLife(socialCommit(), identityPolicy());
		world.store.setWorldBinding("lina", 0, {
			worldId: "test-world",
			projectionPolicyRevision: 1,
		});
		const agents = new AgentStore(join(world.root, "agents.sqlite"));
		cleanup.push(() => agents.close());
		agents.create({
			id: "lina",
			name: "Lina",
			role: "Authored navigator",
			personality: "Authored careful curiosity",
			voice: "Plain",
			profile: "Fictional biography",
			appearance: "Green coat",
			interests: ["stars"],
			avatarId: null,
			evolution: "adaptive",
		});
		const authored = agents.get("lina");
		const policy = () =>
			createSessionContextPolicy({
				version: 1,
				purpose,
				agentId: "lina",
				worldId: "test-world",
				bindingRevision: 1,
				disclosureRevision: 1,
				sourcePolicyVersion: 1,
			});
		async function open() {
			const rpc = createCompanionRpc(world.root);
			cleanup.push(() => rpc.close());
			const services = worldServices();
			let refresh: (() => string) | undefined;
			const session = await createCodexSession({
				workspace: world.root,
				sessionFile: join(world.root, "session.jsonl"),
				agentDir: join(world.root, "auth"),
				agentId: "lina",
				systemPrompt: "Authored base",
				services,
				rpc: rpc.options,
				models: {
					catalog: () => [],
					state: () => ({
						provider: "synthetic",
						model: COMPANION_MODEL,
						settingsRevision: 1,
						error: null,
					}),
					test: async () => {
						throw Error("Unexpected provider call");
					},
				},
				contextPolicy: policy(),
				currentContextPolicy: policy,
				contextExposure: (source) =>
					source.kind === "bootstrap"
						? []
						: [
								{
									kind:
										purpose === "conversation"
											? "shared-growth"
											: "disclosed-life",
									sourceId: `life-state:test-world:${world.store.lifeSnapshot("test-world").revision}:lina`,
								},
							],
				bootstrapInstructions: () => {
					if (!refresh)
						throw Error("Persona registration must precede bootstrap");
					return refresh();
				},
				register(host) {
					refresh = installPersona(
						host,
						agents,
						"lina",
						"Authored base",
						services,
					);
					installWorldContext(host, {
						store: world.store,
						worldId: "test-world",
						agentId: "lina",
						limits,
						lifeLimits: { maxChars: 12000, maxRecords: 30 },
						purpose,
						currentContextPolicy: policy,
						identityPolicy,
					});
				},
			});
			cleanup.push(() => session.close());
			return { rpc, session };
		}
		async function turn(client: Awaited<ReturnType<typeof open>>) {
			const pending = client.session.prompt("hello", {
				signal: new AbortController().signal,
				disposition() {},
				rejected() {
					throw Error("Unexpected rejection");
				},
			});
			const sent = await client.rpc.nextTurn();
			client.rpc.complete(sent);
			await pending;
			const additional = sent.params["additionalContext"] as Record<
				string,
				{ kind: string; value: string }
			>;
			const context = additional["lina-context-reference"];
			expect(context?.kind).toBe("untrusted");
			expect(context?.value).not.toContain("Mira whispered a private word");
			expect(context?.value).not.toContain('"truth"');
			if (purpose === "conversation") {
				expect(context?.value).toContain("Authored axis");
				for (const secret of [
					"The key is red",
					"The hidden key is blue",
					"false-claim",
					"test-world:1",
				])
					expect(JSON.stringify(client.rpc.requests)).not.toContain(secret);
			} else expect(context?.value).toContain("The key is red");
			return sent;
		}
		const first = await open();
		const bootstrap = first.rpc.requests.find(
			(row) => row.method === "thread/start",
		)?.params["developerInstructions"];
		expect(bootstrap).toContain("Authored navigator");
		expect(bootstrap).toContain("Authored careful curiosity");
		expect(bootstrap).not.toContain("The hidden key is blue");
		await turn(first);
		expect(
			first.session
				.contextLineage()
				.some((receipt) => receipt.outcome === "delivered"),
		).toBe(true);
		await first.session.close();
		first.rpc.close();
		const next = await open();
		expect(next.session.sessionId).toBe(first.session.sessionId);
		expect(next.session.nativeEpoch).toBe(first.session.nativeEpoch);
		expect(next.rpc.requests.some((row) => row.method === "thread/start")).toBe(
			false,
		);
		expect(
			next.rpc.requests.find((row) => row.method === "thread/resume")?.params[
				"threadId"
			],
		).toBe(first.session.threadId);
		expect(
			next.session
				.contextLineage()
				.some((receipt) => receipt.outcome === "delivered"),
		).toBe(true);
		await turn(next);
		expect(agents.get("lina")).toEqual(authored);
		expect(agents.changes("lina")).toEqual([]);
	},
);
