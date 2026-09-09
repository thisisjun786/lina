import { afterEach, expect, test } from "bun:test";
import { Type } from "typebox";
import {
	createSessionContextPolicy,
	parseSessionContextPolicy,
} from "../../lina-runtime/src/context-policy.ts";
import {
	conversationV3,
	settled,
	sourceFixture,
} from "./source-provenance-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

test("v3 exact codec rejects undeclared recipients, extra fields and forged digests while v1 remains exact", () => {
	const v3 = conversationV3();
	const { scopeDigest: _digest, ...fields } = v3;
	expect(parseSessionContextPolicy(v3)).toEqual(v3);
	for (const patch of [
		{ conversationRecipientId: "guessed-user" },
		{ bindingRevision: 1 },
		{ disclosureRevision: 1 },
		{ sourcePolicyVersion: 2 },
		{ unexpected: true },
	])
		expect(() => createSessionContextPolicy({ ...fields, ...patch })).toThrow();
	expect(() =>
		parseSessionContextPolicy({ ...v3, scopeDigest: "0".repeat(64) }),
	).toThrow();
	const old = createSessionContextPolicy({
		version: 1,
		purpose: "conversation",
		agentId: "mina",
		worldId: null,
		bindingRevision: 0,
		disclosureRevision: 0,
		sourcePolicyVersion: 1,
	});
	expect(old.scopeDigest).toBe(
		"70bf468c997e893ac82fed963160cfed2df85671c9dceca0402087b388e83b62",
	);
	expect(() =>
		parseSessionContextPolicy({ ...old, conversationRecipientId: null }),
	).toThrow();
});

test("v3 disclosed LIFE requires the explicit world read tool; other tools cannot carry it", async () => {
	const f = sourceFixture();
	cleanups.push(() => f.close());
	f.state.policy = conversationV3("world");
	const opened = await f.open({
		contextExposure: (source) =>
			source.kind === "tool"
				? [{ kind: "disclosed-life", sourceId: "current-projection" }]
				: [],
		register(host) {
			host.registerTool({
				name: "unrelated_tool",
				label: "test",
				description: "test",
				parameters: Type.Object({}),
				execute: () => ({
					content: [{ type: "text", text: "secret" }],
					details: {},
				}),
			});
		},
	});
	const runtime = f.runtime(opened.session),
		done = settled(runtime, "wrong-tool");
	runtime.submit("wrong-tool", "hi");
	await opened.rpc.next("turn/start");
	const reply = await opened.tool("unrelated_tool", "turn-1");
	expect(reply.error).toBeDefined();
	expect(JSON.stringify(reply)).not.toContain("secret");
	opened.rpc.complete(opened.session.threadId);
	await done;
});
