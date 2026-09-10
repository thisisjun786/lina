import { afterEach, expect, test } from "bun:test";
import { createMoiraiProbeGateway } from "../src/moirai-probe-gateway.ts";
import { lifeResponse } from "./life-model-fixture.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
function setup(
	response: () => Response = () => lifeResponse("ok"),
	record: (_key: string, _v: unknown) => void = () => {},
	responseModel?: string,
) {
	let attempts = 0;
	const sent: unknown[] = [];
	const gateway = createMoiraiProbeGateway({
		baseUrl: "https://synthetic.invalid/v1",
		model: "model",
		...(responseModel ? { responseModel } : {}),
		record,
		fetchImpl: (async (_input, init) => {
			attempts++;
			sent.push(JSON.parse(String(init?.body)));
			return response();
		}) as typeof fetch,
	});
	cleanup.push(() => gateway.close());
	const request = (key: string) =>
		fetch(`${gateway.baseUrl}/responses`, {
			method: "POST",
			headers: { authorization: `Bearer ${gateway.nonce}` },
			body: JSON.stringify({
				model: "model",
				instructions: "role",
				stream: true,
				tools: [],
				input: [{ role: "user", content: [{ type: "input_text", text: key }] }],
			}),
		});
	const expectClaim = (key: string) =>
		gateway.expect({
			key,
			episodeId: "episode",
			input: key,
			instructions: "role",
		});
	return {
		gateway,
		request,
		expectClaim,
		sent,
		get attempts() {
			return attempts;
		},
	};
}
test("six cumulative calls admitted, sequential seventh blocked before outbound", async () => {
	const f = setup();
	for (let i = 0; i < 6; i++) {
		const key = `k${i}`;
		f.expectClaim(key);
		const r = await f.request(key);
		await r.text();
		await f.gateway.settled(key);
	}
	f.expectClaim("k6");
	expect((await f.request("k6")).status).toBe(429);
	await expect(f.gateway.settled("k6")).rejects.toThrow();
	expect(f.attempts).toBe(6);
	expect(f.sent[0]).toMatchObject({
		max_output_tokens: 4096,
		tools: [],
		tool_choice: "none",
	});
});
test("duplicate registration and duplicate POST cannot duplicate model calls", async () => {
	const f = setup();
	f.expectClaim("a");
	expect(() =>
		f.gateway.expect({
			key: "b",
			episodeId: "episode",
			input: "a",
			instructions: "role",
		}),
	).toThrow();
	const r = await f.request("a");
	await r.text();
	await f.gateway.settled("a");
	expect((await f.request("a")).status).toBe(409);
	expect(f.attempts).toBe(1);
});
test("partial or malformed SSE never settles successfully", async () => {
	for (const text of [
		"data: {bad}\n\n",
		'data: {"type":"response.created"}\n\n',
		'data: {"type":"response.completed"}',
	]) {
		const f = setup(
			() =>
				new Response(text, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		f.expectClaim("bad");
		const r = await f.request("bad");
		await r.text().catch(() => {});
		await expect(f.gateway.settled("bad")).rejects.toThrow();
		expect(f.attempts).toBe(1);
	}
});
test("durable capture failure rejects even after provider completed", async () => {
	const f = setup(undefined, (key) => {
		if (key.endsWith("-response")) throw Error("disk full");
	});
	f.expectClaim("disk");
	const r = await f.request("disk").catch(() => null);
	await r?.text().catch(() => {});
	await expect(f.gateway.settled("disk")).rejects.toThrow();
});
test("early SSE is delivered before provider completion and mid-stream failure rejects", async () => {
	let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
	const f = setup(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						stream = c;
						c.enqueue(
							new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	f.expectClaim("stream");
	const r = await f.request("stream");
	const reader = r.body?.getReader();
	expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
	stream?.error(Error("upstream lost"));
	await reader?.read().catch(() => {});
	await expect(f.gateway.settled("stream")).rejects.toThrow();
});
test("output overflow fails and failed attempts consume episode budget", async () => {
	const f = setup(
		() =>
			new Response("x".repeat(1048577), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	for (let i = 0; i < 6; i++) {
		const key = `fail${i}`;
		f.expectClaim(key);
		const r = await f.request(key);
		await r.text().catch(() => {});
		await f.gateway.settled(key).catch(() => {});
	}
	f.expectClaim("fail6");
	expect((await f.request("fail6")).status).toBe(429);
	expect(f.attempts).toBe(6);
});

for (const usage of [
	{ input_tokens: 1, output_tokens: 4097, total_tokens: 4098 },
	{ input_tokens: 1, output_tokens: -1, total_tokens: 0 },
	{ input_tokens: "1", output_tokens: 2, total_tokens: 3 },
	{ input_tokens: 1, output_tokens: 2, total_tokens: 1 },
]) {
	test(`invalid or over-budget usage cannot settle: ${JSON.stringify(usage)}`, async () => {
		const records = new Map<string, unknown>();
		const f = setup(
			() => lifeResponse("ok", usage),
			(key, value) => records.set(key, value),
		);
		f.expectClaim("usage");
		const response = await f.request("usage").catch(() => null);
		await response?.text().catch(() => {});
		await expect(f.gateway.settled("usage")).rejects.toThrow();
		expect(records.has("usage-response")).toBe(true);
		expect(records.has("usage-failure")).toBe(true);
		expect(f.attempts).toBe(1);
	});
}

test("absent provider usage stays unknown", async () => {
	const f = setup(() => lifeResponse("ok", null));
	f.expectClaim("unknown");
	await (await f.request("unknown")).text();
	expect(await f.gateway.settled("unknown")).toEqual({ usage: null });
});

for (const model of ["unexpected", undefined, "expected"]) {
	test(`provider model identity is checked when required: ${model ?? "missing"}`, async () => {
		const f = setup(
			() =>
				new Response(
					`data: ${JSON.stringify({
						type: "response.completed",
						response: {
							id: "response",
							model,
							status: "completed",
							output: [{ type: "message" }],
						},
					})}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				),
			undefined,
			"expected",
		);
		f.expectClaim("identity");
		const response = await f.request("identity").catch(() => null);
		await response?.text().catch(() => {});
		if (model === "expected") await f.gateway.settled("identity");
		else await expect(f.gateway.settled("identity")).rejects.toThrow();
		expect(f.attempts).toBe(1);
	});
}
