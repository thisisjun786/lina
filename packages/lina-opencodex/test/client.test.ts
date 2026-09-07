import { expect, test } from "bun:test";
import { type FetchLike, hubSend, readCompletion } from "../src/client.ts";
import { responsesPayload } from "../src/complete.ts";
import { OpenCodexError } from "../src/errors.ts";

const hangUntilAbort: FetchLike = async (_input, init) =>
	new Promise((_, reject) => {
		const signal = init?.signal;
		if (!signal) {
			reject(new Error("missing abort signal"));
			return;
		}
		const fail = () => {
			reject(
				signal.reason instanceof Error
					? signal.reason
					: new DOMException("Aborted", "AbortError"),
			);
		};
		if (signal.aborted) {
			fail();
			return;
		}
		signal.addEventListener("abort", fail, { once: true });
	});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
	});
}

test("hub requests refuse redirects and never follow them", async () => {
	let calls = 0;
	await expect(
		hubSend({
			origin: "http://127.0.0.1:10100",
			path: "/v1/models",
			fetchImpl: async (_input, init) => {
				calls++;
				expect(init?.redirect).toBe("manual");
				return new Response(null, {
					status: 302,
					headers: { location: "https://evil.example/steal" },
				});
			},
		}),
	).rejects.toMatchObject({ code: "redirect_refused" });
	expect(calls).toBe(1);
});

test("responses payload matches the live native contract", () => {
	const body = responsesPayload({
		origin: "http://127.0.0.1:10100",
		model: "gpt-5.6-sol",
		endpoint: "responses",
		systemPrompt: "Be brief.",
		messages: [{ role: "user", content: "Reply exactly LINA_HUB_OK" }],
		signal: new AbortController().signal,
	});
	expect(body["stream"]).toBe(true);
	expect(body["store"]).toBe(false);
	expect(Array.isArray(body["input"])).toBe(true);
	expect(typeof body["input"]).not.toBe("string");
	expect(body["max_output_tokens"]).toBeUndefined();
	expect(body["model"]).toBe("gpt-5.6-sol");
	expect(body["instructions"]).toBe("Be brief.");
	expect(body["input"]).toEqual([
		{
			role: "user",
			content: [{ type: "input_text", text: "Reply exactly LINA_HUB_OK" }],
		},
	]);
});

test("explicit output budget is the only max_output_tokens path", () => {
	const body = responsesPayload({
		origin: "http://127.0.0.1:10100",
		model: "gpt-5.6-sol",
		endpoint: "responses",
		messages: [{ role: "user", content: "hi" }],
		maxOutputTokens: 128,
		signal: new AbortController().signal,
	});
	expect(body["max_output_tokens"]).toBe(128);
});

test("responses history represents assistant answers as output_text, including structured correction attempts", () => {
	const body = responsesPayload({
		origin: "http://127.0.0.1:10100",
		model: "gpt-5.6-luna",
		endpoint: "responses",
		messages: [
			{ role: "assistant", content: "이전 질문" },
			{ role: "user", content: "현재 답변" },
		],
		signal: new AbortController().signal,
	});
	const input = body["input"] as { role: string; content: unknown }[];
	expect(input[0]).toEqual({
		role: "assistant",
		content: [{ type: "output_text", text: "이전 질문" }],
	});
	expect(input[1]).toEqual({
		role: "user",
		content: [{ type: "input_text", text: "현재 답변" }],
	});
});

test("OpenCodexError does not echo secrets", () => {
	const error = new OpenCodexError(
		"provider_auth",
		"failed Authorization: Bearer super-secret-token-value",
	);
	expect(error.message).not.toContain("super-secret-token-value");
});

test("hubSend classifies Bun TimeoutError as timeout and preserves caller abort", async () => {
	await expect(
		hubSend({
			origin: "http://127.0.0.1:10100",
			path: "/v1/models",
			timeoutMs: 20,
			fetchImpl: hangUntilAbort,
		}),
	).rejects.toMatchObject({ code: "timeout", name: "OpenCodexError" });

	await expect(
		hubSend({
			origin: "http://127.0.0.1:10100",
			path: "/v1/models",
			fetchImpl: async () => {
				throw new DOMException("The operation was aborted.", "AbortError");
			},
		}),
	).rejects.toMatchObject({ code: "timeout" });

	const controller = new AbortController();
	const reason = new OpenCodexError("cancelled", "user cancelled hub send");
	const pending = hubSend({
		origin: "http://127.0.0.1:10100",
		path: "/v1/models",
		signal: controller.signal,
		timeoutMs: 8_000,
		fetchImpl: hangUntilAbort,
	});
	controller.abort(reason);
	await expect(pending).rejects.toBe(reason);
});

test("hubSend does not echo upstream bodies, tokens, or raw transport errors", async () => {
	const token = "ocx_live_super_secret_value_zzz";
	try {
		await hubSend({
			origin: "http://127.0.0.1:10100",
			path: "/v1/responses",
			token,
			body: {
				model: "claude-3-5-sonnet-20241022",
				prompt: "secret-user-text",
			},
			fetchImpl: async () => {
				throw new Error(
					`upstream 401 Authorization: Bearer ${token} body={"prompt":"secret-user-text"}`,
				);
			},
		});
		throw new Error("expected hubSend to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(OpenCodexError);
		const message = error instanceof Error ? error.message : String(error);
		expect(message).not.toContain(token);
		expect(message).not.toContain("secret-user-text");
		expect(message).not.toContain("Bearer");
		expect((error as OpenCodexError).code).toBe("unreachable");
	}
});

test("JSON error, incomplete, and length terminals are never accepted summaries", async () => {
	await expect(
		readCompletion(
			jsonResponse({
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output_text: "partial",
				output: [{ content: [{ type: "output_text", text: "partial" }] }],
			}),
			10_000,
		),
	).rejects.toMatchObject({ code: "provider_error" });
	await expect(
		readCompletion(
			jsonResponse({
				error: { message: "boom" },
				output_text: "partial",
			}),
			10_000,
		),
	).rejects.toMatchObject({ code: "provider_error" });
	await expect(
		readCompletion(
			jsonResponse({
				choices: [{ finish_reason: "length", message: { content: "partial" } }],
			}),
			10_000,
		),
	).rejects.toMatchObject({ code: "provider_error" });
	await expect(
		readCompletion(
			jsonResponse({
				status: "completed",
				output_text: "LINA_OK",
				usage: { input_tokens: 1, output_tokens: 2 },
			}),
			10_000,
		),
	).resolves.toEqual({
		text: "LINA_OK",
		inputTokens: 1,
		outputTokens: 2,
	});
});
