import { afterEach, expect, test } from "bun:test";
import {
	identityPolicy,
	lifeDefinition,
	socialCommit,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { createSessionContextPolicy } from "../src/context-policy.ts";
import { installWorldContext } from "../src/world.ts";
import { limits, worldFixture } from "./world-fixture.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanups.splice(0).reverse()) close();
});
const signal = () => new AbortController().signal;

function fixture(purpose: "conversation" | "life", agentId = "lina") {
	const fixture = worldFixture();
	cleanups.push(fixture.close);
	const { store } = fixture;
	store.create(worldDefinition());
	store.prepareLife(lifeDefinition());
	store.acceptLife(socialCommit(), identityPolicy());
	store.setWorldBinding(agentId, 0, {
		worldId: "test-world",
		projectionPolicyRevision: 1,
	});
	const policy = () => {
		const binding = store.worldBinding(agentId);
		return createSessionContextPolicy({
			version: 1,
			purpose,
			agentId,
			worldId: binding?.worldId ?? null,
			bindingRevision: binding?.revision ?? 0,
			disclosureRevision: binding?.projectionPolicyRevision ?? 0,
			sourcePolicyVersion: 1,
		});
	};
	const options = {
		store,
		worldId: "test-world",
		agentId,
		limits,
		lifeLimits: { maxChars: 12000, maxRecords: 30 },
		purpose,
		currentContextPolicy: policy,
		identityPolicy,
	};
	return { ...fixture, options };
}

test("ordinary context shares permitted growth without event text, secret IDs or a raw read tool", async () => {
	const { host: createHost, options } = fixture("conversation");
	const host = createHost();
	installWorldContext(host.asLinaHost(), options);
	const turn = await host.beforeTurn("hello", signal());
	expect(turn.context).toContain("Authored axis");
	expect(turn.context).toContain('"value":1');
	for (const privateValue of [
		"The key is red",
		"hidden key",
		"false-claim",
		"test-world:1",
		'"experiences"',
		'"growthHistory"',
	])
		expect(turn.context).not.toContain(privateValue);
	expect(host.tools.has("lina_world_read")).toBe(false);
});

test("explicit LIFE context reads personal beliefs without oracle truth or another actor's secret", async () => {
	const lina = fixture("life");
	const host = lina.host();
	installWorldContext(host.asLinaHost(), lina.options);
	const result = await host.invokeTool("lina_world_read", "read", {}, signal());
	const body = result.contentItems.map((item) => item.text).join("\n");
	expect(body).toContain("The key is red");
	expect(body).toContain('"stance":"believes"');
	expect(body).not.toContain('"truth"');
	expect(body).not.toContain("Mira whispered a private word");
	const sol = fixture("life", "sol");
	const other = sol.host();
	installWorldContext(other.asLinaHost(), sol.options);
	expect((await other.beforeTurn("hello", signal())).context).not.toContain(
		"The key is red",
	);
	await expect(
		host.invokeTool("lina_world_read", "forged", { agentId: "mira" }, signal()),
	).rejects.toThrow("Invalid tool arguments");
});

test("unbind and world replacement remove old growth and stale raw blocks on the next projection", async () => {
	const { host: createHost, store, options } = fixture("conversation");
	const host = createHost();
	installWorldContext(host.asLinaHost(), options);
	expect((await host.beforeTurn("first", signal())).context).toContain(
		'"value":1',
	);
	store.setWorldBinding("lina", 1, {
		worldId: null,
		projectionPolicyRevision: 0,
	});
	const memory = {
		role: "custom",
		customType: "lina-context-reference",
		content: "real-memory",
	};
	const after = await host.emit(
		"context",
		{
			messages: [
				{
					role: "custom",
					customType: "lina-world-reference",
					content: "old private scene",
				},
				memory,
			],
		},
		signal(),
	);
	expect(JSON.stringify(after)).not.toContain("old private scene");
	expect(JSON.stringify(after)).not.toContain("Authored axis");
	expect(JSON.stringify(after)).toContain("real-memory");
	store.create(worldDefinition("other-world"));
	store.prepareLife(lifeDefinition("other-world"));
	store.setWorldBinding("lina", 2, {
		worldId: "other-world",
		projectionPolicyRevision: 1,
	});
	const switched = await host.beforeTurn("next", signal());
	expect(switched.context).toContain("other-world");
	expect(switched.context).not.toContain('"value":1');
	expect(switched.context).not.toContain("test-world");
});

test("missing or mismatched trusted purpose is rejected before tool registration", () => {
	const { host: createHost, options } = fixture("conversation");
	for (const invalid of [
		{
			store: options.store,
			worldId: options.worldId,
			agentId: options.agentId,
			limits,
		},
		{
			...options,
			currentContextPolicy: () =>
				createSessionContextPolicy({
					version: 1,
					purpose: "life",
					agentId: "mira",
					worldId: "test-world",
					bindingRevision: 1,
					disclosureRevision: 1,
					sourcePolicyVersion: 1,
				}),
		},
	]) {
		const host = createHost();
		// Negative compatibility inputs intentionally bypass the new compile-time contract.
		expect(() =>
			installWorldContext(
				host.asLinaHost(),
				invalid as unknown as Parameters<typeof installWorldContext>[1],
			),
		).toThrow();
		expect(host.tools.size).toBe(0);
	}
});
