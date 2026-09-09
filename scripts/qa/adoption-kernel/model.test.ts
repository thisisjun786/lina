import { expect, test } from "bun:test";
import type { ChatMessage, TransportConfig } from "./harness-types.ts";
import { createTransport } from "./model.ts";

const messages: ChatMessage[] = [
	{ role: "system", content: "system instruction" },
	{ role: "user", content: "user instruction" },
];

function config(overrides: Partial<TransportConfig> = {}): TransportConfig {
	return {
		baseUrl: "https://ollama.example/v1",
		model: "glm-5.3-flash",
		apiKey: "secret-api-key",
		timeoutMs: 1_000,
		maxOutputTokens: 4096,
		temperature: 0,
		...overrides,
	};
}

function completion(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function mockFetch(
	handler: (
		input: Request | string | URL,
		init?: RequestInit,
	) => Promise<Response>,
): typeof fetch {
	return Object.assign(handler, { preconnect: () => {} }) as typeof fetch;
}

test("sends the frozen OpenAI-compatible request and returns validated usage", async () => {
	const calls: Array<{
		input: Request | string | URL;
		init: RequestInit | undefined;
	}> = [];
	const transport = createTransport(
		config({
			fetch: mockFetch(async (input, init) => {
				calls.push({ input, init });
				return completion({
					model: "provider-model-label",
					choices: [{ message: { content: '{"kind":"answer"}' } }],
					usage: { prompt_tokens: 12, completion_tokens: 7 },
				});
			}),
		}),
	);

	const result = await transport.complete(messages);

	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual({
		input: "https://ollama.example/v1/chat/completions",
		init: {
			method: "POST",
			headers: {
				authorization: "Bearer secret-api-key",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: "glm-5.3-flash",
				messages,
				temperature: 0,
				max_tokens: 4096,
				stream: false,
			}),
			signal: expect.any(AbortSignal),
		},
	});
	expect(result).toMatchObject({
		kind: "ok",
		content: '{"kind":"answer"}',
		model: "provider-model-label",
		usage: { prompt: 12, completion: 7 },
	});
});

test("rejects malformed successful responses without exposing their body", async () => {
	const transport = createTransport(
		config({
			fetch: mockFetch(async () =>
				completion({
					choices: [{ message: { content: 42 } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 },
				}),
			),
		}),
	);

	const result = await transport.complete(messages);

	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "decode",
		detail: "invalid response",
	});
});

for (const status of [401, 429, 500]) {
	test(`returns a redacted HTTP ${status} failure`, async () => {
		const transport = createTransport(
			config({
				fetch: mockFetch(
					async () => new Response("sensitive upstream error", { status }),
				),
			}),
		);

		const result = await transport.complete(messages);

		expect(result).toMatchObject({
			kind: "transport-failure",
			reason: "http",
			status,
			detail: "request failed",
		});
	});
}

test("returns a redacted network failure without retrying", async () => {
	let calls = 0;
	const transport = createTransport(
		config({
			fetch: mockFetch(async () => {
				calls += 1;
				throw Error("connection contains secret-api-key");
			}),
		}),
	);

	const result = await transport.complete(messages);

	expect(calls).toBe(1);
	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "network",
		detail: "request failed",
	});
});

test("reports timeout when its timeout signal aborts the request", async () => {
	const transport = createTransport(
		config({
			timeoutMs: 0,
			fetch: mockFetch(
				async (_input, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(new DOMException("aborted", "AbortError")),
							{ once: true },
						);
					}),
			),
		}),
	);

	const result = await transport.complete(messages);

	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "timeout",
		detail: "request timed out",
	});
});

test("reports caller cancellation as a single redacted request failure", async () => {
	let calls = 0;
	const controller = new AbortController();
	controller.abort();
	const transport = createTransport(
		config({
			fetch: mockFetch(async (_input, init) => {
				calls += 1;
				if (init?.signal?.aborted)
					throw new DOMException("aborted", "AbortError");
				return completion({});
			}),
		}),
	);

	const result = await transport.complete(messages, controller.signal);

	expect(calls).toBe(1);
	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "network",
		detail: "request aborted",
	});
});

test("rejects invalid transport configuration", () => {
	expect(() => createTransport(config({ baseUrl: "" }))).toThrow("baseUrl");
});

test("returns a redacted timeout failure when the response body stalls past the deadline", async () => {
	const transport = createTransport(
		config({
			timeoutMs: 0,
			fetch: mockFetch(
				async () =>
					({
						ok: true,
						status: 200,
						headers: { get: () => null },
						json: () => new Promise(() => {}),
					}) as unknown as Response,
			),
		}),
	);

	const result = await transport.complete(messages);

	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "timeout",
		detail: "request timed out",
	});
});

test("rejects a top-level null response body as a decode failure", async () => {
	const transport = createTransport(
		config({
			fetch: mockFetch(async () => completion(null)),
		}),
	);

	const result = await transport.complete(messages);

	expect(result).toMatchObject({
		kind: "transport-failure",
		reason: "decode",
		detail: "invalid response",
	});
});
