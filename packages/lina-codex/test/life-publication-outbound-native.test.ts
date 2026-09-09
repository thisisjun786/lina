import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	LifeModelRequest,
	PublicationModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import { createCodexLifeModel } from "../src/life-model.ts";
import { lifeReference } from "../src/life-model-validation.ts";
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
const signal = () => new AbortController().signal;
function publicationRequest(): PublicationModelRequest {
	const { stepId: _stepId, ...common } = lifeRequest();
	return {
		...common,
		version: 2,
		lane: "publication",
		jobId: "publication-job",
	};
}
function fixture(respond?: Parameters<typeof lifeFixture>[0]) {
	const f = lifeFixture(respond);
	cleanup.push(() => f.close());
	return f;
}
function model(options: Parameters<typeof createCodexLifeModel>[0]) {
	const port = createCodexLifeModel(options);
	cleanup.push(() => port.close());
	return port;
}
function journalDirectory(root: string, request: LifeModelRequest) {
	return join(
		root,
		"life-model",
		lifeReference(request).slice("life-model-".length),
	);
}

nativeTest(
	"publication final receipt denial calls the guard once, makes zero provider calls and reconciles without retry",
	async () => {
		const f = fixture();
		const request = publicationRequest();
		const directory = journalDirectory(f.root, request);
		let receiptStatus = "dispatched";
		const checked: Array<{
			request: LifeModelRequest;
			receiptStatus: string;
			dispatched: boolean;
			outbound: boolean;
			providerCalls: number;
		}> = [];
		const options = {
			...f.options,
			selection() {
				// The final assertCurrent is reached only after native dispatch starts.
				if (existsSync(join(directory, "dispatch.json")))
					receiptStatus = "denied";
				return f.selection;
			},
			beforeOutbound(value: LifeModelRequest) {
				checked.push({
					request: structuredClone(value),
					receiptStatus,
					dispatched: existsSync(join(directory, "dispatch.json")),
					outbound: existsSync(join(directory, "outbound.json")),
					providerCalls: f.captures.length,
				});
				if (receiptStatus !== "dispatched")
					throw Error("Receipt no longer current");
			},
		};
		const port = model(options);
		const prepared = await port.prepare(request, signal());
		expect(checked).toHaveLength(0);
		expect(await port.reconcile(prepared)).toEqual({
			status: "not_dispatched",
		});
		expect(checked).toHaveLength(0);
		await expect(port.complete(prepared, signal())).rejects.toThrow(
			"LIFE native request failed",
		);
		expect(checked).toEqual([
			{
				request,
				receiptStatus: "denied",
				dispatched: true,
				outbound: false,
				providerCalls: 0,
			},
		]);
		expect(f.captures).toHaveLength(0);
		expect(existsSync(join(directory, "outbound.json"))).toBe(false);
		expect(
			JSON.parse(readFileSync(join(directory, "gateway.json"), "utf8")),
		).toMatchObject({
			upstreamAttempts: 0,
			responseReceived: false,
			closed: true,
		});
		const failed = {
			status: "failed",
			upstreamAttempts: 0,
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			reason: "LIFE native request failed",
		} as const;
		expect(await port.reconcile(prepared)).toEqual(failed);
		await port.close();
		// Restored authorization cannot turn a terminal failed request into a retry.
		receiptStatus = "dispatched";
		const reopened = model(options);
		expect(await reopened.reconcile(prepared)).toEqual(failed);
		await expect(reopened.complete(prepared, signal())).rejects.toThrow(
			"no inference retry",
		);
		expect(checked).toHaveLength(1);
		expect(f.captures).toHaveLength(0);
	},
	60000,
);

nativeTest(
	"authorized v2 publication roundtrip guards a clone before the outbound marker and completed replay skips the guard",
	async () => {
		let directory = "";
		let outboundAtProvider = false;
		const f = fixture(() => {
			outboundAtProvider = existsSync(join(directory, "outbound.json"));
			return lifeResponse('{"text":"Synthetic publication"}');
		});
		const request = publicationRequest();
		directory = journalDirectory(f.root, request);
		const checked: LifeModelRequest[] = [];
		let outboundAtGuard = false;
		let dispatchedAtGuard = false;
		const port = model({
			...f.options,
			beforeOutbound(value) {
				checked.push(structuredClone(value));
				outboundAtGuard = existsSync(join(directory, "outbound.json"));
				dispatchedAtGuard = existsSync(join(directory, "dispatch.json"));
				// A trusted hook cannot accidentally change the admitted request or journal.
				value.input = "HOOK_MUTATED_INPUT";
				value.id = "hook-mutated-id";
				value.limits.maxOutputBytes = 1;
			},
		});
		const prepared = await port.prepare(request, signal());
		expect(checked).toHaveLength(0);
		expect(await port.reconcile(prepared)).toEqual({
			status: "not_dispatched",
		});
		expect(checked).toHaveLength(0);
		const result = await port.complete(prepared, signal());
		expect(checked).toEqual([request]);
		expect(dispatchedAtGuard).toBe(true);
		expect(outboundAtGuard).toBe(false);
		expect(outboundAtProvider).toBe(true);
		expect(prepared.request).toEqual(request);
		expect(result).toMatchObject({
			requestId: request.id,
			inputDigest: prepared.inputDigest,
			text: '{"text":"Synthetic publication"}',
			usage: { inputTokens: 31, outputTokens: 7, totalTokens: 38 },
			upstreamAttempts: 1,
		});
		expect(f.captures).toHaveLength(1);
		expect(JSON.stringify(f.captures[0]?.body)).toContain(request.input);
		expect(JSON.stringify(f.captures[0]?.body)).not.toContain(
			"HOOK_MUTATED_INPUT",
		);
		expect(await port.reconcile(prepared)).toEqual({
			status: "completed",
			result,
		});
		expect(await port.complete(prepared, signal())).toEqual(result);
		expect(checked).toHaveLength(1);
		await port.close();
		let replayChecks = 0;
		const reopened = model({
			...f.options,
			beforeOutbound() {
				replayChecks++;
				throw Error("Replay must not authorize new outbound work");
			},
		});
		expect(await reopened.reconcile(prepared)).toEqual({
			status: "completed",
			result,
		});
		expect(await reopened.complete(prepared, signal())).toEqual(result);
		expect(replayChecks).toBe(0);
		expect(f.captures).toHaveLength(1);
	},
	60000,
);

nativeTest(
	"publication final assertCurrent rejects changed selection before calling the outbound guard",
	async () => {
		const f = fixture();
		const request = publicationRequest();
		const directory = journalDirectory(f.root, request);
		let finalChecks = 0;
		let callbacks = 0;
		const port = model({
			...f.options,
			selection() {
				if (existsSync(join(directory, "dispatch.json"))) {
					finalChecks++;
					return { ...f.selection, settingsRevision: 8 };
				}
				return f.selection;
			},
			beforeOutbound() {
				callbacks++;
			},
		});
		const prepared = await port.prepare(request, signal());
		await expect(port.complete(prepared, signal())).rejects.toThrow(
			"LIFE native request failed",
		);
		expect(finalChecks).toBe(1);
		expect(callbacks).toBe(0);
		expect(f.captures).toHaveLength(0);
		expect(await port.reconcile(prepared)).toMatchObject({
			status: "failed",
			upstreamAttempts: 0,
		});
	},
	60000,
);

test("publication malformed and accessor requests never invoke the outbound guard", async () => {
	const f = fixture();
	let callbacks = 0;
	let reads = 0;
	const port = model({
		...f.options,
		beforeOutbound() {
			callbacks++;
		},
	});
	const request = publicationRequest();
	const malformed = { ...request, stepId: "unexpected" };
	await expect(port.prepare(malformed, signal())).rejects.toThrow();
	Object.defineProperty(request, "input", {
		enumerable: true,
		get() {
			reads++;
			return "UNVALIDATED_INPUT";
		},
	});
	await expect(port.prepare(request, signal())).rejects.toThrow();
	expect(reads).toBe(0);
	expect(callbacks).toBe(0);
	expect(f.captures).toHaveLength(0);
});
