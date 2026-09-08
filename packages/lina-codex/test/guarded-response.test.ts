import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Type } from "typebox";
import {
	captureSourceProofs,
	sourceProofsCurrent,
} from "../../lina-core/src/source-policy.ts";
import type { LinaToolResult } from "../../lina-runtime/src/host.ts";
import { CodexHost } from "../src/host.ts";
import { createCodexRpc } from "../src/rpc.ts";
import {
	conversationV3,
	settled,
	sourceFixture,
} from "./source-provenance-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

for (const stage of ["tool-wrapper", "host-event", "session-return"] as const) {
	test(`source change in ${stage} microtask cannot cross the real native RPC write`, async () => {
		const f = sourceFixture();
		cleanup.push(() => f.close());
		f.state.policy = conversationV3("world");
		let revoke = () => {},
			sourceGuard = () => {},
			checks = 0;
		const opened = await f.open({
			contextExposure(source) {
				if (stage === "session-return" && source.kind === "tool")
					queueMicrotask(revoke);
				return [];
			},
			register(host) {
				host.on("tool_execution_end", () => {
					if (stage === "host-event") queueMicrotask(revoke);
				});
				host.registerTool({
					name: "lina_memory_query",
					label: "memory",
					description: "Synthetic guarded query",
					parameters: Type.Object({}),
					async execute(): Promise<LinaToolResult> {
						const result = await Promise.resolve({
							content: [
								{ type: "text" as const, text: "SECRET FROM OLD SOURCE" },
							],
							details: {},
							beforeDeliver: () => {
								checks++;
								sourceGuard();
							},
						});
						if (stage === "tool-wrapper") queueMicrotask(revoke);
						return result;
					},
				});
			},
		});
		const runtime = f.runtime(opened.session);
		const original = settled(runtime, "original");
		runtime.submit("original", "hi");
		await opened.rpc.next("turn/start");
		opened.rpc.complete(opened.session.threadId);
		await original;
		const entryId = f.journal.request("original")?.entryId;
		if (!entryId) throw Error("Missing fixture source");
		const proof = captureSourceProofs([entryId], (id) =>
			f.journal.sourceEntry(id),
		);
		sourceGuard = () => {
			if (!sourceProofsCurrent(proof, (id) => f.journal.sourceEntry(id)))
				throw Error("PRIVATE-PROOF-ID: restricted origin");
		};
		revoke = () => {
			f.journal.recordSourceExposure({
				type: "context_exposure",
				version: 1,
				id: "restricted-source",
				nativeEpoch: 1,
				scopeDigest: f.state.policy.scopeDigest,
				source: {
					kind: "tool",
					requestId: "original",
					toolName: "lina_world_read",
					callId: "restriction",
				},
				materials: [
					{ kind: "disclosed-life", sourceId: "restricted-material" },
				],
				outcome: "planned",
			});
			f.journal.extendRequestSource("original", ["restricted-source"]);
		};
		const queried = settled(runtime, "query");
		runtime.submit("query", "hi");
		await opened.rpc.next("turn/start");
		const reply = await opened.tool("lina_memory_query", "turn-2");
		expect(f.journal.sourceEntry(entryId)?.sourcePolicy?.scope).toBe("mixed");
		if (stage === "session-return") {
			expect(reply.error).toEqual({
				code: -32603,
				message: "Codex request delivery blocked",
			});
		} else {
			// Staleness known before history publication now fails the tool there.
			expect(reply.result).toEqual({
				contentItems: [{ type: "inputText", text: "Tool failed" }],
				success: false,
			});
		}
		expect(JSON.stringify(reply)).not.toContain("SECRET");
		expect(JSON.stringify(reply)).not.toContain("PRIVATE-PROOF-ID");
		expect(checks).toBeGreaterThan(0);
		opened.rpc.complete(opened.session.threadId);
		await queried;
	});
}

async function hostRpc(
	result: LinaToolResult,
	boundary: (
		reply: object,
		register: (check: () => void) => void,
	) => void = () => {},
) {
	const input = new PassThrough(),
		output = new PassThrough();
	const rpc = await createCodexRpc({
		stdio: { input, output },
		ownsProcess: false,
	});
	cleanup.push(async () => {
		await rpc.close();
		input.destroy();
		output.destroy();
	});
	const received = Promise.withResolvers<string>();
	input.once("data", (chunk: Buffer) => received.resolve(chunk.toString()));
	const host = new CodexHost("/synthetic", () => ({ action: "allow" }));
	host.registerTool({
		name: "query",
		label: "query",
		description: "Synthetic guarded response",
		parameters: Type.Object({}),
		execute: () => result,
	});
	rpc.onRequest(async (_method, _params, beforeSend) => {
		const reply = await host.invokeTool(
			"query",
			"call",
			{},
			new AbortController().signal,
		);
		boundary(reply, beforeSend);
		return reply;
	});
	output.write(
		`${JSON.stringify({ id: 1, method: "item/tool/call", params: {} })}\n`,
	);
	return received.promise;
}

test("native scope and result guards both run after serialization; private capabilities stay off wire", async () => {
	const order: string[] = [];
	const wire = await hostRpc(
		{
			content: [{ type: "text", text: "allowed answer" }],
			details: { privateProof: "PRIVATE-ID" },
			beforeDeliver: () => {
				order.push("result-guard");
			},
		},
		(reply, beforeSend) => {
			beforeSend(() => {
				order.push("native-guard");
			});
			Object.defineProperty(reply, "toJSON", {
				value() {
					order.push("serialize");
					return { ...reply };
				},
			});
		},
	);
	expect(order).toEqual([
		"result-guard",
		"serialize",
		"native-guard",
		"result-guard",
	]);
	expect(JSON.parse(wire)).toEqual({
		id: 1,
		result: {
			contentItems: [{ type: "inputText", text: "allowed answer" }],
			success: true,
		},
	});
	expect(wire).not.toContain("beforeDeliver");
	expect(wire).not.toContain("PRIVATE-ID");
});

for (const stage of ["rpc-handler-return", "serialization"] as const) {
	test(`guard survives ${stage} change even without a session scope guard`, async () => {
		let allowed = true;
		const wire = await hostRpc(
			{
				content: [{ type: "text", text: "SECRET" }],
				details: {},
				beforeDeliver() {
					if (!allowed) throw Error("PRIVATE-PROOF-ID");
				},
			},
			(reply) => {
				if (stage === "rpc-handler-return")
					queueMicrotask(() => {
						allowed = false;
					});
				else
					Object.defineProperty(reply, "toJSON", {
						value() {
							allowed = false;
							return { ...reply };
						},
					});
			},
		);
		expect(JSON.parse(wire)).toEqual({
			id: 1,
			error: { code: -32603, message: "Codex request delivery blocked" },
		});
		expect(wire).not.toContain("SECRET");
		expect(wire).not.toContain("PRIVATE-PROOF-ID");
	});
}

test("normal tools preserve their native shape and JSON metadata cannot become a guard", async () => {
	const wire = await hostRpc({
		content: [{ type: "text", text: "ordinary result" }],
		details: {
			beforeDeliver: "model-provided",
			sourceProofs: [{ ordinary: true }],
		},
	});
	expect(JSON.parse(wire)).toEqual({
		id: 1,
		result: {
			contentItems: [{ type: "inputText", text: "ordinary result" }],
			success: true,
		},
	});
});

for (const method of [
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
]) {
	test(`${method} keeps the native scope guard across the final handler await`, async () => {
		const f = sourceFixture();
		cleanup.push(() => f.close());
		f.state.policy = conversationV3("world");
		let armRevocation = false;
		const opened = await f.open({
			currentContextPolicy() {
				if (armRevocation) {
					armRevocation = false;
					queueMicrotask(() => {
						f.state.policy = conversationV3();
					});
				}
				return f.state.policy;
			},
			register(host) {
				host.on("tool_call", () => undefined);
				host.on("tool_execution_end", () => {
					armRevocation = true;
				});
			},
		});
		const runtime = f.runtime(opened.session);
		const done = settled(runtime, "approval");
		runtime.submit("approval", "hi");
		await opened.rpc.next("turn/start");
		opened.rpc.options.stdio.output.write(
			`${JSON.stringify({
				id: "approval-response",
				method,
				params: {
					threadId: opened.session.threadId,
					turnId: "turn-1",
					itemId: "native-item",
					command: "synthetic",
					reason: "synthetic",
				},
			})}\n`,
		);
		const reply = await opened.rpc.next("response:approval-response");
		expect(f.state.policy.worldId).toBeNull();
		expect(reply.error).toEqual({
			code: -32603,
			message: "Codex request delivery blocked",
		});
		expect(JSON.stringify(reply)).not.toContain("accept");
		await done;
		expect(f.journal.request("approval")?.status).toBe("interrupted");
	});
}
