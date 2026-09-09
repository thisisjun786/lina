import { afterEach, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import * as rpcModule from "../src/rpc.ts";
import {
	CodexRpcRemoteError,
	isCodexRpcRemoteError as isRemote,
} from "../src/rpc.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function request() {
	const input = new PassThrough(),
		output = new PassThrough();
	const rpc = await rpcModule.createCodexRpc({
		stdio: { input, output },
		ownsProcess: false,
	});
	cleanup.push(async () => {
		await rpc.close();
		input.destroy();
		output.destroy();
	});
	const sent = Promise.withResolvers<{ id: number }>();
	input.once("data", (chunk: Buffer) =>
		sent.resolve(JSON.parse(chunk.toString())),
	);
	const abort = new AbortController();
	const result = rpc
		.request("turn/steer", {}, abort.signal)
		.catch((error) => error);
	const frame = await sent.promise;
	return { rpc, output, result, abort, id: frame.id };
}

test("only the exact decoded remote rejection is classified regardless of its message", async () => {
	const f = await request();
	f.output.write(
		`${JSON.stringify({ id: f.id, error: { code: -32602, message: "transport closed", data: { secret: "not exposed" } } })}\n`,
	);
	const error: unknown = await f.result;
	expect(isRemote(error)).toBe(true);
	expect(error).toMatchObject({ message: "transport closed", code: -32602 });
	expect(error).not.toHaveProperty("data");
	expect(isRemote(new Error("transport closed"))).toBe(false);
	expect(
		isRemote({
			name: "CodexRpcRemoteError",
			message: "transport closed",
			code: -32602,
		}),
	).toBe(false);
});

for (const reply of [
	{ error: { message: "rejected" } },
	{ error: { code: "-32602", message: "rejected" } },
	{ error: { code: -32602, message: "rejected" }, result: {} },
]) {
	test(`malformed or ambiguous reply is not a remote rejection: ${JSON.stringify(reply)}`, async () => {
		const f = await request();
		f.output.write(`${JSON.stringify({ id: f.id, ...reply })}\n`);
		expect(isRemote(await f.result)).toBe(false);
	});
}

test("foreign error IDs cannot classify a later connection loss as rejection", async () => {
	const f = await request();
	f.output.write(
		`${JSON.stringify({ id: f.id + 1, error: { code: -32602, message: "rejected" } })}\n`,
	);
	f.output.end();
	expect(isRemote(await f.result)).toBe(false);
});

test("local cancellation is not remote rejection", async () => {
	const f = await request();
	f.abort.abort(new Error("rejected"));
	expect(isRemote(await f.result)).toBe(false);
});

test("trusted FakeRPC can construct remote rejection without trusting lookalike prototypes", () => {
	expect(isRemote(new CodexRpcRemoteError("synthetic rejection", -32602))).toBe(
		true,
	);
	expect(isRemote(Object.create(CodexRpcRemoteError.prototype))).toBe(false);
});
