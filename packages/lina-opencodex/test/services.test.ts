import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ModelRole,
	ModelSettings,
} from "../../lina-runtime/src/models/types.ts";
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
	expect(posts[0]?.body["max_output_tokens"]).toBe(512);
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

test("summary enforces caller output limit before sending", async () => {
	const { hub, posts } = await connectedHub();
	const saved = settings();
	saved.profiles = saved.profiles.map((profile) => ({
		...profile,
		maxOutputTokens: 1024,
	}));
	const services = hub.createContextServices(() => saved);
	await services.summarize("archive", 64, new AbortController().signal);
	expect(posts[0]?.body["max_output_tokens"]).toBe(64);
});

test("invalid caller budget makes no provider request", async () => {
	const { hub, posts } = await connectedHub();
	const services = hub.createContextServices(() => settings());
	await expect(
		services.summarize("archive", -1, new AbortController().signal),
	).rejects.toMatchObject({ code: "invalid_input" });
	expect(posts).toHaveLength(0);
});

test("configured output beyond live catalog is rejected without fallback", async () => {
	const { hub, posts } = await connectedHub();
	const saved = settings();
	saved.profiles = saved.profiles.map((profile) => ({
		...profile,
		maxOutputTokens: 128001,
	}));
	await expect(
		hub
			.createContextServices(() => saved)
			.summarize("archive", 64, new AbortController().signal),
	).rejects.toMatchObject({ code: "output_budget_exceeded" });
	expect(posts).toHaveLength(0);
});

test("advertised effort mismatch is rejected before dispatch", async () => {
	const { createOpenCodexContextServices } = await import("../src/services.ts");
	let calls = 0;
	const services = createOpenCodexContextServices(
		{
			origin: () => "http://127.0.0.1:10100",
			token: () => null,
			models: () => [
				{
					provider: "opencodex",
					id: "gpt-5.6-sol",
					name: "test",
					contextWindow: 128000,
					maxOutputTokens: 8192,
					reasoning: true,
					reasoningEfforts: ["low"],
					authenticated: true,
					endpoint: "responses",
				},
			],
			fetchImpl: async () => {
				calls++;
				return sse("ok");
			},
		},
		() => ({
			...settings(),
			profiles: settings().profiles.map((profile) => ({
				...profile,
				reasoning: "high" as const,
			})),
		}),
	);
	await expect(
		services.summarize("archive", 64, new AbortController().signal),
	).rejects.toMatchObject({ code: "reasoning_unsupported" });
	expect(calls).toBe(0);
});

function tierSettings(): ModelSettings {
	return {
		...settings(),
		routes: {
			version: 1,
			tiers: {
				quick: { profileId: "main", reasoning: "off", maxOutputTokens: 128 },
				standard: { profileId: "main", reasoning: "low", maxOutputTokens: 256 },
				deep: { profileId: "main", reasoning: "medium", maxOutputTokens: 512 },
				intensive: {
					profileId: "main",
					reasoning: "high",
					maxOutputTokens: 1024,
				},
			},
			roleTiers: { summary: "deep" },
		},
	};
}

test("active summary tier reaches request and cache invalidates on revision", async () => {
	const { hub, posts } = await connectedHub();
	let saved = tierSettings();
	const services = hub.createContextServices(() => saved);
	const previous = services.summaryCacheKey?.();
	await services.summarize("archive", 2048, new AbortController().signal);
	expect(posts[0]?.body).toMatchObject({
		reasoning: { effort: "medium" },
		max_output_tokens: 512,
	});
	saved = { ...saved, revision: 4 };
	expect(services.summaryCacheKey?.()).not.toBe(previous);
	expect(hub.createModelControl(() => saved).state().model).toBe("gpt-5.6-sol");
});

test("direct tier request selects each configured effort and budget", async () => {
	const { hub, posts } = await connectedHub();
	const services = hub.createContextServices(() => tierSettings());
	const tiers = ["quick", "standard", "deep", "intensive"] as const;
	for (const tier of tiers)
		await services.summarize(
			"archive",
			2048,
			new AbortController().signal,
			undefined,
			{ tier },
		);
	expect(posts.map((p) => p.body["max_output_tokens"])).toEqual([
		128, 256, 512, 1024,
	]);
	expect(posts.map((p) => p.body["reasoning"])).toEqual([
		undefined,
		{ effort: "low" },
		{ effort: "medium" },
		{ effort: "high" },
	]);
});

test("catalog projection preserves effort capabilities without sharing arrays", async () => {
	const { publicCatalog } = await import("../src/catalog.ts");
	const efforts = ["low", "high"];
	const projected = publicCatalog([
		{
			provider: "opencodex",
			id: "test",
			name: "test",
			contextWindow: 128000,
			maxOutputTokens: 8192,
			reasoning: true,
			reasoningEfforts: efforts,
			defaultReasoning: "low",
			authenticated: true,
			endpoint: "responses",
		},
	]);
	expect(projected[0]?.reasoningEfforts).toEqual(["low", "high"]);
	expect(projected[0]?.defaultReasoning).toBe("low");
	efforts.push("medium");
	expect(projected[0]?.reasoningEfforts).toEqual(["low", "high"]);
});

test("tier options cross real loopback HTTP for responses and chat endpoints", async () => {
	const { createOpenCodexContextServices } = await import("../src/services.ts");
	const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests.push({
				path: new URL(request.url).pathname,
				body: (await request.json()) as Record<string, unknown>,
			});
			if (request.url.endsWith("/chat/completions"))
				return new Response(
					'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			return sse("ok");
		},
	});
	try {
		for (const endpoint of ["responses", "chat"] as const) {
			const service = createOpenCodexContextServices(
				{
					origin: () => `http://127.0.0.1:${server.port}`,
					token: () => null,
					models: () => [
						{
							provider: "opencodex",
							id: "gpt-5.6-sol",
							name: "test",
							contextWindow: 128000,
							maxOutputTokens: 8192,
							reasoning: true,
							reasoningEfforts: ["low", "medium", "high"],
							authenticated: true,
							endpoint,
						},
					],
				},
				() => tierSettings(),
			);
			expect(
				await service.summarize("archive", 64, new AbortController().signal),
			).toBe("ok");
		}
		expect(requests[0]).toMatchObject({
			path: "/v1/responses",
			body: {
				model: "gpt-5.6-sol",
				max_output_tokens: 64,
				reasoning: { effort: "medium" },
			},
		});
		expect(requests[1]).toMatchObject({
			path: "/v1/chat/completions",
			body: {
				model: "gpt-5.6-sol",
				max_tokens: 64,
				reasoning_effort: "medium",
			},
		});
	} finally {
		await server.stop(true);
	}
});

test("internal calls recheck catalog authentication and role capability", async () => {
	const { createOpenCodexContextServices } = await import("../src/services.ts");
	for (const unavailable of [
		{ authenticated: false },
		{ authenticated: true, supportedRoles: ["conversation"] as ModelRole[] },
	]) {
		let calls = 0;
		const service = createOpenCodexContextServices(
			{
				origin: () => "http://127.0.0.1:10100",
				token: () => null,
				models: () => [
					{
						provider: "opencodex",
						id: "gpt-5.6-sol",
						name: "test",
						contextWindow: 128000,
						maxOutputTokens: 8192,
						reasoning: false,
						endpoint: "responses",
						...unavailable,
						...(unavailable.supportedRoles
							? { supportedRoles: [...unavailable.supportedRoles] }
							: {}),
					},
				],
				fetchImpl: async () => {
					calls++;
					return sse("ok");
				},
			},
			() => settings(),
		);
		await expect(
			service.summarize("archive", 64, new AbortController().signal),
		).rejects.toMatchObject({ code: "model_unavailable" });
		expect(calls).toBe(0);
	}
});

test("route info distinguishes requested effort from unsupported and unverified application", async () => {
	const { hub } = await connectedHub();
	const saved = tierSettings();
	const service = hub.createContextServices(() => saved);
	expect(service.routeInfo?.("summary", undefined, 64)).toMatchObject({
		mode: "tier",
		tier: "deep",
		settingsRevision: 3,
		requested: { reasoning: "medium", maxOutputTokens: 512 },
		applied: { reasoning: "medium", maxOutputTokens: 64 },
		reasoningStatus: "unverified",
	});
	const textSaved = tierSettings();
	textSaved.profiles = textSaved.profiles.map((profile) => ({
		...profile,
		model: "cursor/composer-2.5-fast",
	}));
	expect(
		hub.createContextServices(() => textSaved).routeInfo?.("summary"),
	).toMatchObject({
		requested: { reasoning: "medium" },
		applied: { reasoning: "off" },
		reasoningStatus: "model_no_reasoning",
	});
});

test("internal observe recall and reflect accept a tier and retain dispatch guards", async () => {
	const { hub, posts } = await connectedHub();
	const service = hub.createContextServices(() => tierSettings());
	let guarded = 0;
	const guard = () => {
		guarded++;
	};
	const signal = new AbortController().signal;
	await service.observe?.("facts", signal, guard, { tier: "standard" });
	await service.reasonMemory?.("question", signal, guard, { tier: "deep" });
	await service.reflect?.('{"preferencesOnly":true}', signal, guard, {
		tier: "intensive",
	});
	expect(guarded).toBe(3);
	expect(posts.map((p) => p.body["reasoning"])).toEqual([
		{ effort: "low" },
		{ effort: "medium" },
		{ effort: "high" },
	]);
	expect(JSON.stringify(posts)).not.toContain("beforeDispatch");
});
