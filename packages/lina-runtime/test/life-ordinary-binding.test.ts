import { expect, test } from "bun:test";
import {
	identityPolicy,
	lifeDefinition,
} from "../../lina-core/test/life-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { createOrdinaryWorldContext } from "../src/world.ts";
import { worldFixture } from "./world-fixture.ts";

test("ordinary source follows explicit binding, records actual recall only and masks failed work revocation", async () => {
	const f = worldFixture();
	try {
		f.store.create(worldDefinition());
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
		f.store.prepareLife(def);
		let workCurrent = true;
		const context = createOrdinaryWorldContext("lina", () => ({
			store: f.store,
			limits: { maxChars: 12000, maxRecords: 30 },
			identityPolicy,
			assertSourceCurrent() {
				if (!workCurrent) throw Error("Failed restriction delivery");
			},
		}));
		const host = f.host();
		context.install(host.asLinaHost());
		expect(context.policy().worldId).toBeNull();
		f.store.setWorldBinding("lina", 0, {
			version: 2,
			worldId: "test-world",
			projectionPolicyRevision: 1,
			conversationRecipientId: "owner",
		});
		const selected = context.policy();
		expect(context.growth()?.agentId).toBe("lina");
		expect(
			JSON.stringify(
				await host.beforeTurn("hello", new AbortController().signal),
			),
		).not.toContain("hidden key");
		expect(
			context
				.exposure({ kind: "turn", requestId: "r" })
				.every((m) => m.kind === "shared-growth"),
		).toBe(true);
		const result = await host.invokeTool(
			"lina_world_read",
			"actual",
			{},
			new AbortController().signal,
		);
		expect(JSON.stringify(result)).toContain("hidden key");
		expect(
			context.exposure({
				kind: "tool",
				requestId: "r",
				toolName: "lina_world_read",
				callId: "actual",
			}),
		).toMatchObject([{ kind: "disclosed-life" }]);
		expect(
			context.exposure({
				kind: "tool",
				requestId: "r",
				toolName: "lina_world_read",
				callId: "never",
			}),
		).toEqual([]);
		workCurrent = false;
		expect(context.policy().scopeDigest).not.toBe(selected.scopeDigest);
		expect(context.policy()).toMatchObject({
			worldId: "test-world",
			conversationRecipientId: null,
		});
		expect(context.growth()?.agentId).toBe("lina");
		expect(
			JSON.stringify(
				await host.invokeTool(
					"lina_world_read",
					"masked",
					{},
					new AbortController().signal,
				),
			),
		).not.toContain("hidden key");
		expect(
			context.exposure({
				kind: "tool",
				requestId: "r",
				toolName: "lina_world_read",
				callId: "masked",
			}),
		).toEqual([]);
		f.store.setWorldBinding("lina", 1, {
			version: 2,
			worldId: null,
			projectionPolicyRevision: 0,
			conversationRecipientId: null,
		});
		expect(context.policy()).toMatchObject({
			worldId: null,
			bindingRevision: 0,
			conversationRecipientId: null,
		});
		expect(context.growth()).toBeNull();
	} finally {
		f.close();
	}
});
