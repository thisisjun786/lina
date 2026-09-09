import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
	captureSourceProofs,
	sourceProofsCurrent,
} from "../../lina-core/src/source-policy.ts";
import { createCodexRpc, isCodexRpcRemoteError } from "../src/rpc.ts";
import {
	conversationV3,
	settled,
	sourceFixture,
} from "./source-provenance-fixture.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

for (const stage of [
	"context-await",
	"injection-ack",
	"cached-instructions",
] as const) {
	test(`learned prompt proof survives ${stage} through actual native request writes`, async () => {
		const f = sourceFixture();
		cleanup.push(() => f.close());
		f.state.policy = conversationV3("world");
		const entered = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		let learn = false,
			blockContext = false,
			guardCalls = 0;
		let check = () => {};
		const opened = await f.open({
			register(host) {
				host.on("before_agent_start", () =>
					learn
						? {
								systemPrompt: "SECRET_LEARNED_PROMPT",
								beforeDeliver() {
									guardCalls++;
									check();
								},
							}
						: undefined,
				);
				host.on("context", async () => {
					if (blockContext) {
						entered.resolve();
						await release.promise;
					}
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
		if (!entryId) throw Error("Source entry missing");
		const proofs = captureSourceProofs([entryId], (id) =>
			f.journal.sourceEntry(id),
		);
		check = () => {
			if (!sourceProofsCurrent(proofs, (id) => f.journal.sourceEntry(id)))
				throw Error("PRIVATE_PROOF_ID");
		};
		const revoke = () => {
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
		opened.rpc.hook((frame) => {
			if (frame.method === "turn/start")
				queueMicrotask(() => opened.rpc.complete(opened.session.threadId));
			if (
				stage === "injection-ack" &&
				frame.method === "thread/inject_items" &&
				JSON.stringify(frame).includes("SECRET_LEARNED_PROMPT")
			)
				queueMicrotask(revoke);
			return undefined;
		});
		learn = true;
		if (stage === "cached-instructions") {
			const warm = settled(runtime, "warm");
			runtime.submit("warm", "hi");
			await warm;
			expect(f.journal.request("warm")?.status).toBe("settled");
		}
		blockContext = stage !== "injection-ack";
		const before = opened.rpc.frames.length;
		const done = settled(runtime, "learned");
		runtime.submit("learned", "hi");
		if (blockContext) {
			await entered.promise;
			revoke();
			release.resolve();
		}
		await done;
		const frames = opened.rpc.frames.slice(before);
		expect(f.journal.sourceEntry(entryId)?.sourcePolicy?.scope).toBe("mixed");
		expect(frames.filter((frame) => frame.method === "turn/start")).toEqual([]);
		if (stage !== "injection-ack")
			expect(JSON.stringify(frames)).not.toContain("SECRET_LEARNED_PROMPT");
		else
			expect(
				frames.some((frame) => frame.method === "thread/inject_items"),
			).toBe(true);
		expect(guardCalls).toBeGreaterThan(0);
		expect(f.journal.request("learned")?.status).toBe("rejected");
		expect(JSON.stringify(runtime.snapshot())).not.toContain(
			"PRIVATE_PROOF_ID",
		);
	});
}

test("trusted prompt guard stays private across instruction and turn requests", async () => {
	const f = sourceFixture();
	cleanup.push(() => f.close());
	let checks = 0;
	const opened = await f.open({
		register(host) {
			host.on("before_agent_start", () => ({
				systemPrompt: "Current learned prompt",
				beforeDeliver() {
					checks++;
				},
			}));
		},
	});
	const runtime = f.runtime(opened.session);
	const done = settled(runtime, "current");
	runtime.submit("current", "hi");
	await opened.rpc.next("turn/start");
	opened.rpc.complete(opened.session.threadId);
	await done;
	expect(checks).toBe(2);
	expect(JSON.stringify(opened.rpc.frames)).not.toMatch(
		/beforeDeliver|sourceProofs|policyDigest/,
	);
});

test("outbound guard runs after serialization, sanitizes failure and leaves RPC usable", async () => {
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
	const frames: unknown[] = [],
		order: string[] = [];
	input.on("data", (chunk: Buffer) => {
		const frame = JSON.parse(chunk.toString());
		frames.push(frame);
		output.write(`${JSON.stringify({ id: frame.id, result: {} })}\n`);
	});
	let current = true;
	const params = {
		toJSON() {
			order.push("serialize");
			current = false;
			return { text: "SECRET" };
		},
	};
	const error = await rpc
		.request("turn/start", params, undefined, () => {
			order.push("guard");
			if (!current) throw Error("PRIVATE_PROOF_ID");
		})
		.catch((error) => error);
	expect(order).toEqual(["serialize", "guard"]);
	expect(frames).toEqual([]);
	expect(error).toMatchObject({ message: "Codex request dispatch blocked" });
	expect(isCodexRpcRemoteError(error)).toBe(false);
	await expect(rpc.request("model/list", {})).resolves.toEqual({});
	expect(frames).toHaveLength(1);
});
