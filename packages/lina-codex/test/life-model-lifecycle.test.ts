import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexLifeModel } from "../src/life-model.ts";
import { LifeNativeOwnership } from "../src/life-model-native.ts";
import * as rpcModule from "../src/rpc.ts";
import {
	lifeFixture,
	lifeRequest,
	lifeResponse,
} from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
function fixture(respond?: Parameters<typeof lifeFixture>[0]) {
	const f = lifeFixture(respond);
	clean.push(() => f.close());
	const port = createCodexLifeModel(f.options);
	clean.push(() => port.close());
	return { ...f, port };
}

test("ownership retains an unsuccessful close until a later close succeeds", async () => {
	const owner = new LifeNativeOwnership();
	let attempts = 0;
	owner.retain(async () => {
		attempts++;
		if (attempts === 1) throw Error("synthetic close failure");
	});
	await expect(owner.close()).rejects.toThrow();
	await owner.close();
	await owner.close();
	expect(attempts).toBe(2);
});

nativeTest(
	"close waits for a pending native open and observes its owned child exit",
	async () => {
		const f = fixture();
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const opened = Promise.withResolvers<rpcModule.CodexRpc>(),
			release = Promise.withResolvers<void>();
		const original = rpcModule.createCodexRpc;
		const spy = spyOn(rpcModule, "createCodexRpc").mockImplementation(
			async (options) => {
				const rpc = await original(options);
				opened.resolve(rpc);
				await release.promise;
				return rpc;
			},
		);
		clean.push(() => spy.mockRestore());
		const running = f.port.complete(prepared, signal());
		void running.catch(() => undefined);
		const rpc = await opened.promise;
		let closed = false;
		const closing = f.port.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve();
		await closing;
		await expect(running).rejects.toThrow();
		expect(rpc.closed).toBe(true);
		expect(() => process.kill(rpc.pid as number, 0)).toThrow();
		expect(f.captures).toHaveLength(0);
	},
	60000,
);

nativeTest(
	"active native receives only the nonce and close shuts down its child and gateway",
	async () => {
		const release = Promise.withResolvers<Response>();
		const f = fixture(() => release.promise);
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const directory = join(
			f.root,
			"life-model",
			prepared.nativeReference.slice("life-model-".length),
		);
		const controller = new AbortController();
		const running = f.port.complete(prepared, controller.signal);
		void running.catch(() => undefined);
		await f.entered;
		const binding = JSON.parse(
			readFileSync(join(directory, "binding.json"), "utf8"),
		);
		const transport = JSON.parse(
			readFileSync(join(directory, "transport.json"), "utf8"),
		);
		const cmdline = readFileSync(`/proc/${binding.pid}/cmdline`, "utf8");
		expect(cmdline).not.toContain("synthetic-parent-credential");
		expect(cmdline).toContain("OPENCODEX_API_AUTH_TOKEN");
		expect(readFileSync(`/proc/${binding.pid}/environ`, "utf8")).not.toContain(
			"synthetic-parent-credential",
		);
		controller.abort();
		await f.port.close();
		await expect(running).rejects.toThrow();
		release.resolve(lifeResponse());
		expect(() => process.kill(binding.pid, 0)).toThrow();
		await expect(fetch(`${transport.baseUrl}/responses`)).rejects.toThrow();
		expect(
			JSON.parse(readFileSync(join(directory, "gateway.json"), "utf8")),
		).toMatchObject({ closed: true, upstreamAttempts: 1 });
	},
	60000,
);
