import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import { OpenCodexHub } from "../src/index.ts";

const sol = {
	id: "gpt-5.6-sol",
	object: "model",
	api_types: ["chat_completions", "responses"],
	capabilities: {
		context_length: 372000,
		max_output_tokens: 128000,
		input_modalities: ["text", "image"],
		supports_reasoning: true,
		supports_vision: true,
	},
};
const textOnly = {
	id: "cursor/composer-2.5-fast",
	object: "model",
	api_types: ["chat_completions", "responses"],
	capabilities: {
		context_length: 200000,
		input_modalities: ["text"],
		supports_reasoning: false,
		supports_vision: false,
	},
};

function settings(model = "gpt-5.6-sol"): ModelSettings {
	return {
		revision: 3,
		profiles: [{ id: "main", provider: "opencodex", model, reasoning: "off" }],
		defaultProfileId: "main",
		roles: {},
		agentRoles: {},
	};
}

function sse(text: string): Response {
	const body =
		"data: " +
		JSON.stringify({
			type: "response.completed",
			response: {
				output: [
					{
						type: "message",
						content: [{ type: "output_text", text }],
					},
				],
				usage: { input_tokens: 8, output_tokens: 3 },
			},
		}) +
		"\n\n";
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

async function connectedHub(
	onPost?: (
		url: string,
		body: Record<string, unknown>,
		headers: Headers,
	) => Response,
) {
	const dir = mkdtempSync(join(tmpdir(), "lina-ocx-svc-"));
	mkdirSync(join(dir, ".opencodex"), { recursive: true });
	writeFileSync(
		join(dir, ".opencodex", "config.json"),
		JSON.stringify({
			unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
		}),
	);
	const posts: Array<{
		url: string;
		body: Record<string, unknown>;
		headers: Headers;
	}> = [];
	const hub = new OpenCodexHub({
		env: {},
		homeDir: dir,
		fetchImpl: async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			if (url.endsWith("/v1/models"))
				return new Response(
					JSON.stringify({ object: "list", data: [sol, textOnly] }),
					{
						headers: { "content-type": "application/json" },
					},
				);
			if (url.endsWith("/v1/catalog"))
				return new Response(
					JSON.stringify({ error: { code: "catalog_not_found" } }),
					{
						status: 404,
						headers: { "content-type": "application/json" },
					},
				);
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			posts.push({ url, body, headers });
			expect(headers.has("authorization")).toBe(false);
			if (onPost) return onPost(url, body, headers);
			return sse("ok");
		},
	});
	await hub.refresh();
	return { hub, posts };
}

test("summary returns a string and posts the live responses shape with the exact model id", async () => {
	const { hub, posts } = await connectedHub();
	const services = hub.createContextServices(
		() => settings(),
		undefined,
		"SYSTEM",
	);
	const text = await services.summarize(
		"archive text",
		512,
		new AbortController().signal,
	);
	expect(typeof text).toBe("string");
	expect(text).toBe("ok");
	expect(posts).toHaveLength(1);
	expect(posts[0]?.url).toBe("http://127.0.0.1:10100/v1/responses");
	expect(posts[0]?.body).toMatchObject({
		model: "gpt-5.6-sol",
		stream: true,
		store: false,
	});
	expect(Array.isArray(posts[0]?.body["input"])).toBe(true);
	expect(posts[0]?.body["max_output_tokens"]).toBeUndefined();
});

test("missing catalog model is a structural error with no silent fallback", async () => {
	const { hub, posts } = await connectedHub();
	const services = hub.createContextServices(() => settings("no-such-model"));
	await expect(
		services.summarize("archive", 64, new AbortController().signal),
	).rejects.toMatchObject({ code: "model_unavailable" });
	expect(posts).toHaveLength(0);
});

test("vision sends a binary data URL and refuses text-only models", async () => {
	const { hub, posts } = await connectedHub();
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	const services = hub.createContextServices(() => settings());
	const result = await services.analyzeImage?.(
		{ bytes, mimeType: "image/png", question: "What color?" },
		new AbortController().signal,
	);
	expect(result).toMatchObject({
		provider: "opencodex",
		model: "gpt-5.6-sol",
		text: "ok",
	});
	const content = posts[0]?.body["input"] as Array<{
		content: Array<{ type: string; image_url?: string }>;
	}>;
	const image = content[0]?.content.find((part) => part.type === "input_image");
	expect(image?.image_url?.startsWith("data:image/png;base64,")).toBe(true);

	const textOnlyServices = hub.createContextServices(() =>
		settings("cursor/composer-2.5-fast"),
	);
	await expect(
		textOnlyServices.analyzeImage?.(
			{ bytes, mimeType: "image/png" },
			new AbortController().signal,
		),
	).rejects.toMatchObject({ code: "vision_unavailable" });
});

test("model trial uses the exact requested id and returns the trial shape", async () => {
	const { hub } = await connectedHub();
	const trial = await hub
		.createModelControl(() => settings())
		.test(
			{
				id: "main",
				provider: "opencodex",
				model: "gpt-5.6-sol",
				reasoning: "off",
			},
			"ping",
			new AbortController().signal,
		);
	expect(trial).toMatchObject({
		provider: "opencodex",
		model: "gpt-5.6-sol",
		text: "ok",
		inputTokens: 8,
		outputTokens: 3,
	});
	expect(typeof trial.durationMs).toBe("number");
});

test("prepare is owned by the session engine", async () => {
	const { hub } = await connectedHub();
	const services = hub.createContextServices(() => settings());
	expect(() =>
		services.prepare({
			requestId: "r1",
			reason: "overflow",
			branchEntries: [],
			preparation: {
				firstKeptEntryId: "a",
				tokensBefore: 1,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
			},
		}),
	).toThrow(/prepare at the session seam/);
});
