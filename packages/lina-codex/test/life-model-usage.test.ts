import { afterEach, expect, test } from "bun:test";
import { createCodexLifeModel } from "../src/life-model.ts";
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
function fixture(response: () => Response) {
	const f = lifeFixture(response);
	clean.push(() => f.close());
	const port = createCodexLifeModel(f.options);
	clean.push(() => port.close());
	return { ...f, port };
}
const signal = () => new AbortController().signal;

nativeTest(
	"missing provider usage remains unknown instead of adopting native estimates",
	async () => {
		const f = fixture(() => lifeResponse("missing-usage", null));
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const result = await f.port.complete(prepared, signal());
		expect(result.usage).toEqual({
			inputTokens: null,
			outputTokens: null,
			totalTokens: null,
		});
		expect(await f.port.reconcile(prepared)).toEqual({
			status: "completed",
			result,
		});
	},
	60000,
);

nativeTest(
	"observed usage over admission is retained and model text cannot forge transport totals",
	async () => {
		const f = fixture(() =>
			lifeResponse('{"usage":{"inputTokens":0},"upstreamAttempts":0}', {
				input_tokens: 5001,
				output_tokens: 2003,
				total_tokens: 7004,
			}),
		);
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const result = await f.port.complete(prepared, signal());
		expect(result.usage).toEqual({
			inputTokens: 5001,
			outputTokens: 2003,
			totalTokens: 7004,
		});
		expect(result.upstreamAttempts).toBe(1);
		expect(f.captures[0]?.body["max_output_tokens"]).toBeUndefined();
		expect(f.captures[0]?.body["max_tokens"]).toBeUndefined();
	},
	60000,
);

nativeTest(
	"native output text over byte bound fails while keeping known usage",
	async () => {
		const f = fixture(() => lifeResponse("x".repeat(120)));
		const request = lifeRequest();
		request.limits.maxOutputBytes = 100;
		const prepared = await f.port.prepare(request, signal());
		await expect(f.port.complete(prepared, signal())).rejects.toThrow();
		expect(await f.port.reconcile(prepared)).toMatchObject({
			status: "failed",
			upstreamAttempts: 1,
			usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
		});
		expect(f.captures).toHaveLength(1);
	},
	60000,
);
