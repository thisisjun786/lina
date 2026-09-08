import { afterEach, expect, test } from "bun:test";
import { responseDeliveryCheck } from "../../lina-codex/src/guarded-response.ts";
import {
	identityPolicy,
	lifeDefinition,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { createSessionContextPolicy } from "../src/context-policy.ts";
import { installWorldContext } from "../src/world.ts";
import { limits, worldFixture } from "./world-fixture.ts";

const close: Array<() => void> = [];
afterEach(() => {
	for (const fn of close.splice(0).reverse()) fn();
});
test("ordinary recall requires explicit recipient disclosure, injects no event automatically and keeps its final permission guard", async () => {
	const f = worldFixture();
	close.push(f.close);
	const { store } = f;
	store.create(worldDefinition());
	const def = lifeDefinition();
	def.projection.disclosures = [
		{
			subject: { kind: "world_fact", id: "secret" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "owner" }],
				publication: ["owner"],
			},
		},
	];
	store.prepareLife(def);
	store.setWorldBinding("lina", 0, {
		version: 2,
		worldId: "test-world",
		projectionPolicyRevision: 1,
		conversationRecipientId: "owner",
	});
	const policy = () => {
		const b = store.worldBinding("lina");
		return createSessionContextPolicy({
			version: 3,
			purpose: "conversation",
			agentId: "lina",
			worldId: b?.worldId ?? null,
			bindingRevision: b?.revision ?? 0,
			disclosureRevision: b?.projectionPolicyRevision ?? 0,
			sourcePolicyVersion: 1,
			conversationRecipientId:
				b?.version === 2 ? b.conversationRecipientId : null,
		});
	};
	const host = f.host();
	installWorldContext(host.asLinaHost(), {
		store,
		worldId: "test-world",
		agentId: "lina",
		purpose: "conversation",
		limits,
		lifeLimits: { maxChars: 12000, maxRecords: 30 },
		identityPolicy,
		currentContextPolicy: policy,
	});
	const signal = new AbortController().signal;
	expect((await host.beforeTurn("hello", signal)).context).not.toContain(
		"hidden key",
	);
	expect(host.tools.has("lina_world_read")).toBe(true);
	const reply = await host.invokeTool("lina_world_read", "read", {}, signal);
	expect(JSON.stringify(reply)).toContain("hidden key");
	const guard = responseDeliveryCheck(reply);
	expect(guard).toBeFunction();
	store.setWorldBinding("lina", 1, {
		version: 2,
		worldId: "test-world",
		projectionPolicyRevision: 1,
		conversationRecipientId: null,
	});
	expect(() => guard?.()).toThrow(/world|source|permission|authority/i);
	expect(
		JSON.stringify(
			await host.invokeTool("lina_world_read", "empty", {}, signal),
		),
	).not.toContain("hidden key");
	await expect(
		host.invokeTool(
			"lina_world_read",
			"forged",
			{ recipientId: "owner" },
			signal,
		),
	).rejects.toThrow(/arguments/i);
});
