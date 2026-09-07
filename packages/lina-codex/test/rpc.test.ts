import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createCodexRpc } from "../src/rpc.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

function fakeStdio() {
	const input = new PassThrough();
	const output = new PassThrough();
	let buffer = "";
	const lines: unknown[] = [];
	const waiters: Array<(value: unknown) => void> = [];
	input.on("data", (chunk: Buffer | string) => {
		buffer += chunk.toString("utf8");
		let idx = buffer.indexOf("\n");
		while (idx >= 0) {
			const line = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 1);
			if (line.trim()) {
				const parsed: unknown = JSON.parse(line);
				const waiter = waiters.shift();
				if (waiter) waiter(parsed);
				else lines.push(parsed);
			}
			idx = buffer.indexOf("\n");
		}
	});
	return {
		input,
		output,
		reply(value: unknown) {
			output.write(`${JSON.stringify(value)}\n`);
		},
		async next(): Promise<unknown> {
			const queued = lines.shift();
			if (queued !== undefined) return queued;
			return await new Promise((resolve) => waiters.push(resolve));
		},
		end() {
			output.end();
			input.end();
		},
	};
}

test("request matches responses by id and subscribe receives notifications", async () => {
	const io = fakeStdio();
	const rpc = await createCodexRpc({
		stdio: { input: io.input, output: io.output },
		ownsProcess: false,
		timeoutMs: 2_000,
	});
	cleanup.push(() => rpc.close());
	const notices: Array<{ method: string; params: unknown }> = [];
	rpc.subscribe((method, params) => notices.push({ method, params }));
	const pending = rpc.request<{ ok: boolean }>("initialize", { n: 1 });
	expect(await io.next()).toEqual({
		id: 1,
		method: "initialize",
		params: { n: 1 },
	});
	io.reply({
		method: "thread/started",
		params: { thread: { id: "t1" } },
		emittedAtMs: 1,
	});
	io.reply({ id: 1, result: { ok: true } });
	expect(await pending).toEqual({ ok: true });
	expect(notices).toEqual([
		{ method: "thread/started", params: { thread: { id: "t1" } } },
	]);
});

test("server request id 0 is answered and unknown methods are denied", async () => {
	const io = fakeStdio();
	const rpc = await createCodexRpc({
		stdio: { input: io.input, output: io.output },
		ownsProcess: false,
		timeoutMs: 2_000,
	});
	cleanup.push(() => rpc.close());
	rpc.onRequest(async (method, params) => {
		if (method === "item/tool/call") return { ok: params };
	});
	io.reply({
		method: "item/tool/call",
		id: 0,
		params: { tool: "lina_probe" },
	});
	expect(await io.next()).toEqual({
		id: 0,
		result: { ok: { tool: "lina_probe" } },
	});
	io.reply({
		method: "mystery/request",
		id: 7,
		params: { x: 1 },
	});
	const denied = (await io.next()) as {
		id: number;
		error: { code: number; message: string };
	};
	expect(denied.id).toBe(7);
	expect(denied.error.code).toBe(-32601);
	expect(denied.error.message).toContain("mystery/request");
});

test("pending requests reject on EOF and on timeout", async () => {
	const eof = fakeStdio();
	const rpc = await createCodexRpc({
		stdio: { input: eof.input, output: eof.output },
		ownsProcess: false,
		timeoutMs: 2_000,
	});
	cleanup.push(() => rpc.close());
	const pending = rpc.request("thread/read", { threadId: "x" });
	await ioDrain(eof);
	eof.output.end();
	await expect(pending).rejects.toThrow(/EOF|closed|ended/i);

	const slow = fakeStdio();
	const timed = await createCodexRpc({
		stdio: { input: slow.input, output: slow.output },
		ownsProcess: false,
		timeoutMs: 30,
	});
	cleanup.push(() => timed.close());
	await expect(timed.request("thread/list", {})).rejects.toThrow(/timeout/i);
});

test("close kills only the owned child", async () => {
	const owned = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	const ownedRpc = await createCodexRpc({
		command: process.execPath,
		args: ["-e", "process.stdin.resume()"],
		ownsProcess: true,
		timeoutMs: 1_000,
	});
	const ownedPid = ownedRpc.pid;
	expect(ownedPid).toBeGreaterThan(0);
	await ownedRpc.close();
	expect(alive(ownedPid)).toBe(false);
	owned.kill();

	const foreign = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
		stdio: ["pipe", "pipe", "pipe"],
	});
	cleanup.push(() => {
		foreign.kill();
	});
	expect(foreign.pid).toBeGreaterThan(0);
	const io = fakeStdio();
	const injected = await createCodexRpc({
		stdio: { input: io.input, output: io.output },
		ownsProcess: false,
		timeoutMs: 1_000,
	});
	await injected.close();
	expect(alive(foreign.pid)).toBe(true);
});

function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function ioDrain(io: { next: () => Promise<unknown> }): Promise<void> {
	await io.next();
}

test("notify writes a method without id", async () => {
	const io = fakeStdio();
	const client = await createCodexRpc({
		stdio: { input: io.input, output: io.output },
		ownsProcess: false,
		timeoutMs: 2_000,
	});
	cleanup.push(() => client.close());
	client.notify("initialized", {});
	expect(await io.next()).toEqual({ method: "initialized", params: {} });
});
