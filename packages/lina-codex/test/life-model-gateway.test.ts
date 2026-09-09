import { afterEach, expect, test } from "bun:test";
import { createLifeModelGateway } from "../src/life-model-gateway.ts";
import {
	lifeFixture,
	lifeRequest,
	lifeResponse,
} from "./life-model-fixture.ts";

const clean: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of clean.splice(0).reverse()) await close();
});
function setup(respond?: Parameters<typeof lifeFixture>[0]) {
	const f = lifeFixture(respond);
	clean.push(() => f.close());
	let marked = 0;
	const gate = createLifeModelGateway({
		baseUrl: f.selection.connection.baseUrl,
		credential: "synthetic-parent-credential",
		request: lifeRequest(),
		signal: new AbortController().signal,
		beforeOutbound: () => {
			marked++;
		},
		observed: () => {},
	});
	clean.push(() => gate.close());
	const send = (body: unknown, token = gate.nonce, path = "/responses") =>
		fetch(`${gate.baseUrl}${path}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: typeof body === "string" ? body : JSON.stringify(body),
		});
	return { ...f, gate, send, marked: () => marked };
}
const body = {
	model: "life-probe",
	tools: [],
	input: [
		{
			role: "user",
			content: [{ type: "input_text", text: "LINA_PRIVATE_OBSERVATION" }],
		},
	],
	instructions: "SCOPED_SYSTEM",
	stream: true,
};
test("SSE EOF does not dispatch an unterminated completed event", async () => {
	const wire = (await lifeResponse().text()).trimEnd() + "\n";
	const f = setup(
		() =>
			new Response(wire, { headers: { "content-type": "text/event-stream" } }),
	);
	expect((await f.send(body)).status).toBe(200);
	expect(f.gate.usage).toEqual({
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
	});
});
for (const format of ["no-space", "multiline", "cr-bom"] as const) {
	test(`gateway reads completed usage from valid ${format} SSE framing`, async () => {
		const response = lifeResponse();
		let wire = await response.text();
		if (format === "no-space") wire = wire.replace(/^data: /gm, "data:");
		if (format === "multiline")
			wire = wire.replace(/^data: (.+)$/gm, (_line, data: string) =>
				JSON.stringify(JSON.parse(data), null, 2)
					.split("\n")
					.map((line) => `data:${line}`)
					.join("\n"),
			);
		if (format === "cr-bom")
			wire = `\ufeff:comment\r${wire.replace(/\n/g, "\r")}`;
		const f = setup(
			() =>
				new Response(wire, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect((await f.send(body)).status).toBe(200);
		expect(f.gate.usage).toEqual({
			inputTokens: 31,
			outputTokens: 7,
			totalTokens: 38,
		});
		expect(f.captures).toHaveLength(1);
	});
}
test("owned nonce gate validates path, model, body and nonce before forwarding", async () => {
	const f = setup();
	for (const value of [
		"{",
		{ ...body, model: "foreign" },
		{ ...body, tools: [{ type: "function", name: "exec_command" }] },
		"x".repeat(100000),
	])
		expect((await f.send(value)).status).toBeGreaterThanOrEqual(400);
	expect((await f.send(body, "foreign")).status).toBe(401);
	expect(
		(await f.send(body, f.gate.nonce, "/../other")).status,
	).toBeGreaterThanOrEqual(400);
	expect(f.captures).toHaveLength(0);
	expect(f.marked()).toBe(0);
});
test("owned nonce gate forwards once and records usage even when a second POST is denied", async () => {
	const f = setup();
	expect((await f.send(body)).status).toBe(200);
	expect(f.marked()).toBe(1);
	expect((await f.send(body)).status).toBe(409);
	expect(f.captures).toHaveLength(1);
	expect(f.gate.usage).toEqual({
		inputTokens: 31,
		outputTokens: 7,
		totalTokens: 38,
	});
	expect(f.gate.upstreamAttempts).toBe(1);
	expect(f.gate.deniedPosts).toBe(1);
});
test("gate never follows a provider redirect or retries an error", async () => {
	const f = setup(
		() =>
			new Response("", {
				status: 307,
				headers: { location: "http://127.0.0.1:1/trap" },
			}),
	);
	expect((await f.send(body)).status).toBe(502);
	expect((await f.send(body)).status).toBe(409);
	expect(f.captures).toHaveLength(1);
});

test("concurrent gateway requests still have a single upstream attempt", async () => {
	const f = setup();
	const results = await Promise.all([f.send(body), f.send(body), f.send(body)]);
	expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
	expect(f.captures).toHaveLength(1);
	expect(f.marked()).toBe(1);
});

test("gateway rejects response byte overflow and preserves an uncertain dispatched attempt", async () => {
	const f = setup(
		() =>
			new Response("x".repeat(100000), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	expect((await f.send(body)).status).toBe(502);
	expect(f.gate.upstreamAttempts).toBe(1);
	expect(f.gate.responseReceived).toBe(false);
	expect((await f.send(body)).status).toBe(409);
	expect(f.captures).toHaveLength(1);
});

test("gateway rejects unknown transport fields and foreign input before dispatch", async () => {
	const f = setup();
	for (const changed of [
		{ ...body, arbitrary_url: "http://127.0.0.1:1" },
		{
			...body,
			input: [
				{
					role: "user",
					content: [{ type: "input_text", text: "FOREIGN_INPUT" }],
				},
			],
		},
		{
			...body,
			input: [
				{
					role: "user",
					content: [
						{ type: "input_image", image_url: "http://127.0.0.1:1/image" },
					],
				},
			],
		},
	])
		expect((await f.send(changed)).status).toBe(400);
	expect(f.captures).toHaveLength(0);
});
