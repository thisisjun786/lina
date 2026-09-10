import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LiveCapture, startLiveCapture } from "./live-capture.ts";

const model = "ollama-cloud/glm-5.3-flash";
const secret = "synthetic-capture-credential";
const sse =
	'data: {"model":"glm-5.3-flash","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
const body = {
	model,
	messages: [{ role: "user", content: "Synthetic capture test" }],
	stream: true,
	max_tokens: 9000,
	tools: [{ type: "function", function: { name: "lookup_inventory" } }],
};

async function withCapture(
	upstreamFetch: (request: Request) => Response | Promise<Response>,
	check: (capture: LiveCapture, root: string) => Promise<void>,
) {
	const root = await mkdtemp(join(tmpdir(), "senpi-capture-check-"));
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: upstreamFetch,
	});
	let capture: LiveCapture | undefined;
	try {
		capture = startLiveCapture({
			upstreamBaseUrl: `${upstream.url.origin}/v1`,
			credential: secret,
			evidenceDir: root,
		});
		await check(capture, root);
	} finally {
		if (capture) expect((await capture.close()).closed).toBe(true);
		await upstream.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}

function send(capture: LiveCapture, requestBody: unknown = body) {
	return fetch(`${capture.baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-private-header": secret },
		body: JSON.stringify(requestBody),
	});
}

test("capture forwards bounded requests and preserves SSE without credential artifacts", async () => {
	// Given an independent upstream recording actual HTTP inputs.
	let received: unknown;
	let authorization: string | null = null;
	let privateHeader: string | null = null;
	await withCapture(
		async (request) => {
			received = await request.json();
			authorization = request.headers.get("authorization");
			privateHeader = request.headers.get("x-private-header");
			return new Response(sse, {
				headers: {
					"content-type": "text/event-stream",
					"x-request-id": "fixture-request",
					"set-cookie": secret,
				},
			});
		},
		async (capture, root) => {
			// When the actual proxy forwards the request.
			const response = await send(capture);
			// Then forwarded body, response and independent stored bytes agree.
			expect(response.status).toBe(200);
			expect(await response.text()).toBe(sse);
			expect(received).toEqual({
				...body,
				max_tokens: 4096,
				stream_options: { include_usage: true },
			});
			expect(authorization).toBe(`Bearer ${secret}`);
			expect(privateHeader).toBeNull();
			expect(capture.records).toHaveLength(1);
			expect(capture.records[0]?.request).toEqual(received);
			expect(capture.records[0]?.response).toBe(sse);
			expect(capture.records[0]?.headers["x-request-id"]).toBe(
				"fixture-request",
			);
			expect(JSON.stringify(capture.records)).not.toContain(secret);
			const stored = await readFile(join(root, "wire-1.json"), "utf8");
			expect(stored).not.toContain(secret);
			expect(JSON.parse(stored)).toEqual(capture.records[0]);
		},
	);
});

test("wrong model and path are rejected before upstream dispatch", async () => {
	// Given an upstream that counts physical dispatches.
	let dispatches = 0;
	await withCapture(
		() => {
			dispatches++;
			return new Response(sse);
		},
		async (capture) => {
			// When invalid boundary inputs reach the proxy.
			const wrongModel = await send(capture, { ...body, model: "other-model" });
			const wrongPath = await fetch(`${capture.baseUrl}/models`);
			// Then neither input causes a provider call.
			expect(wrongModel.status).toBe(400);
			expect(wrongPath.status).toBe(404);
			expect(dispatches).toBe(0);
			expect(capture.records).toHaveLength(0);
		},
	);
});

test("the seventh model request is refused without a seventh upstream dispatch", async () => {
	// Given the fixed six-call episode allowance.
	let dispatches = 0;
	await withCapture(
		() => {
			dispatches++;
			return new Response(sse, {
				headers: { "content-type": "text/event-stream" },
			});
		},
		async (capture) => {
			// When all six admitted requests and one extra are sent.
			for (let index = 0; index < 6; index++) {
				expect((await send(capture)).status).toBe(200);
			}
			const rejected = await send(capture);
			// Then the cap is enforced at the actual dispatch boundary.
			expect(rejected.status).toBe(429);
			expect(dispatches).toBe(6);
			expect(capture.records).toHaveLength(6);
		},
	);
});

test("upstream failures are retained and secrets are redacted", async () => {
	// Given an upstream failure that includes the known synthetic credential.
	await withCapture(
		() => new Response(`Provider rejected ${secret}`, { status: 503 }),
		async (capture) => {
			// When the proxy receives the failed response.
			const response = await send(capture);
			await response.text();
			// Then failure remains observable, not dropped or retried.
			expect(response.status).toBe(503);
			expect(capture.records).toHaveLength(1);
			expect(capture.records[0]?.status).toBe(503);
			expect(capture.records[0]?.response).toContain("[REDACTED]");
			expect(JSON.stringify(capture.records)).not.toContain(secret);
		},
	);
});
