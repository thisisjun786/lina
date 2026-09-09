import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	bindLifeNative,
	LifeNativeOwnership,
	runLifeNative,
} from "../src/life-model-native.ts";
import { lifePlan } from "../src/life-model-policy.ts";
import * as rpcModule from "../src/rpc.ts";
import { authorRpcFixture } from "./author-rpc-fixture.ts";
import { lifeFixture, lifeRequest } from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});

for (const method of [
	"item/tool/call",
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"item/tool/requestUserInput",
])
	nativeTest(
		`LIFE RPC fails native ${method} without application execution`,
		async () => {
			const f = lifeFixture();
			clean.push(() => f.close());
			const request = lifeRequest();
			const plan = bindLifeNative(
				lifePlan(f.options, request),
				join(f.root, "native"),
				{ baseUrl: "http://127.0.0.1:1/v1" },
			);
			const fake = authorRpcFixture(
				f.root,
				plan.workspace,
				readFileSync(join(plan.home, "config.toml"), "utf8"),
				request.model,
			);
			clean.push(() => fake.close());
			const original = rpcModule.createCodexRpc;
			const spy = spyOn(rpcModule, "createCodexRpc").mockImplementation(() =>
				original(fake.options),
			);
			clean.push(() => spy.mockRestore());
			const ownership = new LifeNativeOwnership();
			clean.push(() => ownership.close());
			const running = runLifeNative({
				plan,
				request,
				nonce: "synthetic-nonce",
				signal: new AbortController().signal,
				ownership,
			});
			void running.catch(() => undefined);
			const start = await fake.next("turn/start");
			void fake.request(method, start.params["threadId"] as string, {
				tool: "lina_work_create",
				arguments: {},
			});
			await expect(running).rejects.toThrow(/violation/);
			expect(
				fake.frames.find((frame) => frame.method === "thread/start")?.params[
					"dynamicTools"
				],
			).toEqual([]);
			expect(f.captures).toHaveLength(0);
		},
		15000,
	);
