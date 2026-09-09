import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexLifeModel } from "../src/life-model.ts";
import {
	lifeFixture,
	lifeRequest,
	lifeResponse,
} from "./life-model-fixture.ts";

const nativeTest =
	process.env["LINA_LIFE_NATIVE_TEST"] === "1" ? test : test.skip;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture(respond?: Parameters<typeof lifeFixture>[0]) {
	const f = lifeFixture(respond);
	cleanup.push(() => f.close());
	const port = createCodexLifeModel(f.options);
	cleanup.push(() => port.close());
	return { ...f, port };
}
const signal = () => new AbortController().signal;

test("LIFE rejects accessors without executing them", async () => {
	const f = fixture();
	let reads = 0;
	const request = lifeRequest();
	Object.defineProperty(request, "input", {
		enumerable: true,
		get() {
			reads++;
			return "side effect";
		},
	});
	await expect(f.port.prepare(request, signal())).rejects.toThrow();
	expect(reads).toBe(0);
});

nativeTest(
	"LIFE reconciliation rejects a corrupt outbound ownership marker",
	async () => {
		const f = fixture();
		const prepared = await f.port.prepare(lifeRequest(), signal());
		await f.port.complete(prepared, signal());
		const path = join(
			f.root,
			"life-model",
			prepared.nativeReference.slice("life-model-".length),
			"outbound.json",
		);
		const record = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...record, requestId: "foreign" }));
		await expect(f.port.reconcile(prepared)).rejects.toThrow();
		expect(f.captures).toHaveLength(1);
	},
	60000,
);

test("LIFE rejects unknown request fields and exact route mismatches before any provider request", async () => {
	const f = fixture();
	for (const change of [
		{ tools: [] },
		{ provider: "other" },
		{ model: "other" },
		{ modelSettingsRevision: 8 },
		{ limits: { ...lifeRequest().limits, timeoutMs: 0 } },
	]) {
		await expect(
			f.port.prepare({ ...lifeRequest(), ...change }, signal()),
		).rejects.toThrow();
	}
	expect(f.captures).toHaveLength(0);
});

nativeTest(
	"native LIFE prepares locally, dispatches once, journals exact usage and reconciles across restart",
	async () => {
		const f = fixture();
		const request = lifeRequest();
		const prepared = await f.port.prepare(request, signal());
		expect(f.captures).toHaveLength(0);
		expect(await f.port.reconcile(prepared)).toEqual({
			status: "not_dispatched",
		});
		const result = await f.port.complete(prepared, signal());
		expect(result).toMatchObject({
			requestId: request.id,
			inputDigest: prepared.inputDigest,
			text: '{"choice":"quiet"}',
			usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
			upstreamAttempts: 1,
		});
		expect(f.captures).toHaveLength(1);
		expect(f.captures[0]?.authorization).toBe(
			"Bearer synthetic-parent-credential",
		);
		const wire = JSON.stringify(f.captures[0]?.body);
		expect(wire).toContain("LINA_PRIVATE_OBSERVATION");
		expect(wire).toContain("SCOPED_SYSTEM");
		for (const absent of [
			"synthetic-parent-credential",
			"UNSELECTED_METADATA_INSTRUCTIONS",
			"UNTRUSTED_PROVIDER_TABLE",
			"lina_work",
			"exec_command",
			"web_search",
			"image_generation",
			"mcp__",
			"memory_search",
		])
			expect(wire).not.toContain(absent);
		await f.port.close();
		const reopened = createCodexLifeModel(f.options);
		cleanup.push(() => reopened.close());
		expect(await reopened.reconcile(prepared)).toEqual({
			status: "completed",
			result,
		});
		expect(await reopened.complete(prepared, signal())).toEqual(result);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);

nativeTest(
	"native LIFE gives each actor its own thread and scoped request",
	async () => {
		const f = fixture();
		const one = await f.port.prepare(lifeRequest(), signal());
		const two = await f.port.prepare(
			lifeRequest({
				agentId: "mira",
				lane: "target",
				input: "MIRA_OBSERVATION",
			}),
			signal(),
		);
		const first = await f.port.complete(one, signal());
		const second = await f.port.complete(two, signal());
		expect(one.nativeReference).not.toBe(two.nativeReference);
		expect(first.threadId).not.toBe(second.threadId);
		expect(JSON.stringify(f.captures[1]?.body)).not.toContain(
			"LINA_PRIVATE_OBSERVATION",
		);
	},
	60000,
);

nativeTest(
	"native LIFE rejects a malicious followup without a second upstream POST and preserves usage",
	async () => {
		const f = fixture(() => lifeResponse("", undefined, "skills.list"));
		const prepared = await f.port.prepare(lifeRequest(), signal());
		await expect(f.port.complete(prepared, signal())).rejects.toThrow();
		expect(f.captures).toHaveLength(1);
		expect(await f.port.reconcile(prepared)).toMatchObject({
			status: "failed",
			upstreamAttempts: 1,
			usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
		});
		const gateway = JSON.parse(
			readFileSync(
				join(
					f.root,
					"life-model",
					prepared.nativeReference.slice("life-model-".length),
					"gateway.json",
				),
				"utf8",
			),
		);
		expect(gateway.deniedPosts).toBe(1);
	},
	60000,
);

nativeTest(
	"cancellation after outbound stays unknown and close drains the owned dispatch",
	async () => {
		const release = Promise.withResolvers<Response>();
		const f = fixture(() => release.promise);
		const prepared = await f.port.prepare(lifeRequest(), signal());
		const controller = new AbortController();
		const running = f.port.complete(prepared, controller.signal);
		void running.catch(() => undefined);
		await f.entered;
		controller.abort();
		await f.port.close();
		await expect(running).rejects.toThrow();
		release.resolve(lifeResponse());
		const reopened = createCodexLifeModel(f.options);
		cleanup.push(() => reopened.close());
		expect(await reopened.reconcile(prepared)).toEqual({
			status: "unknown",
			usage: { inputTokens: null, outputTokens: null, totalTokens: null },
			upstreamAttempts: 1,
		});
		await expect(reopened.complete(prepared, signal())).rejects.toThrow(
			/unknown|dispatched/i,
		);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);
