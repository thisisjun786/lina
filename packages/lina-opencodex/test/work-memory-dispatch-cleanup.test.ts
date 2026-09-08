import { expect, spyOn, test } from "bun:test";
import { hubSend, readCompletion } from "../src/client.ts";
import { complete } from "../src/complete.ts";
import { dispatchFixture } from "./work-memory-dispatch-fixture.ts";

test("a thrown guard preserves its error and disposes its timer and abort listener before fetch", async () => {
	const fixture = dispatchFixture();
	const reason = new Error("Source revision changed");
	const schedule = spyOn(globalThis, "setTimeout");
	const clear = spyOn(globalThis, "clearTimeout");
	const remove = spyOn(AbortSignal.prototype, "removeEventListener");
	try {
		await expect(
			hubSend({
				origin: fixture.runtime.origin(),
				path: "/v1/responses",
				fetchImpl: fixture.runtime.fetchImpl,
				beforeDispatch: () => {
					throw reason;
				},
			}),
		).rejects.toBe(reason);
		expect(schedule).toHaveBeenCalledTimes(1);
		const timer = schedule.mock.results[0]?.value;
		expect(clear).toHaveBeenCalledWith(timer);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(fixture.fetchCalls).toBe(0);
		expect(fixture.requests).toHaveLength(0);
	} finally {
		schedule.mockRestore();
		clear.mockRestore();
		remove.mockRestore();
		await fixture.close();
	}
});

test("cancellation before dispatch refuses fetch and does not run the guard", async () => {
	const fixture = dispatchFixture();
	let checks = 0;
	const reason = new Error("Fixture cancelled");
	try {
		await expect(
			complete({
				origin: fixture.runtime.origin(),
				model: "fixture-model",
				endpoint: "responses",
				messages: [{ role: "user", content: "fixture" }],
				signal: AbortSignal.abort(reason),
				fetchImpl: fixture.runtime.fetchImpl,
				beforeDispatch: () => {
					checks++;
				},
			}),
		).rejects.toBe(reason);
		expect(checks).toBe(0);
		expect(fixture.fetchCalls).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("timeout stays active after response headers while the completion body is read", async () => {
	const response = await hubSend({
		origin: "http://127.0.0.1",
		path: "/v1/responses",
		timeoutMs: 20,
		fetchImpl: async (_input, init) => {
			const signal = init?.signal;
			if (!signal) throw new Error("Missing request signal");
			return new Response(
				new ReadableStream({
					start(controller) {
						signal.addEventListener(
							"abort",
							() => controller.error(signal.reason),
							{ once: true },
						);
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		},
		beforeDispatch: () => {},
	});
	await expect(readCompletion(response, 1024)).rejects.toMatchObject({
		name: "TimeoutError",
	});
});

test("request preparation errors remain sanitized and never invoke the guard or fetch", async () => {
	const fixture = dispatchFixture();
	const body: Record<string, unknown> = {};
	body["private-fixture-source"] = body;
	let checks = 0;
	try {
		for (const options of [{ body }, { timeoutMs: -1 }]) {
			await expect(
				hubSend({
					origin: fixture.runtime.origin(),
					path: "/v1/responses",
					...options,
					fetchImpl: fixture.runtime.fetchImpl,
					beforeDispatch: () => {
						checks++;
					},
				}),
			).rejects.toMatchObject({
				code: "unreachable",
				message: "OpenCodex request did not complete",
			});
		}
		expect(checks).toBe(0);
		expect(fixture.fetchCalls).toBe(0);
	} finally {
		await fixture.close();
	}
});
