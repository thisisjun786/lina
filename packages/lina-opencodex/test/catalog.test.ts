import { expect, test } from "bun:test";
import { deriveNativeCatalog, parseHubModels } from "../src/catalog.ts";

const astra = {
	id: "gpt-6-astra",
	object: "model",
	owned_by: "openai",
	api_types: ["chat_completions", "responses", "anthropic_messages"],
	capabilities: {
		context_length: 372000,
		input_modalities: ["text", "image"],
		supports_reasoning: true,
		supports_vision: true,
	},
};
const sol = {
	id: "gpt-5.6-sol",
	object: "model",
	capabilities: {
		context_length: 372000,
		max_output_tokens: 128000,
		input_modalities: ["text", "image"],
		supports_reasoning: true,
		supports_vision: true,
	},
};
const claude = {
	id: "anthropic/claude-fable-5-1",
	object: "model",
	capabilities: {
		context_length: 1000000,
		max_output_tokens: 128000,
		supports_reasoning: true,
	},
};
const textOnly = {
	id: "cursor/composer-2.5-fast",
	object: "model",
	capabilities: {
		context_length: 200000,
		input_modalities: ["text"],
		supports_reasoning: false,
		supports_vision: false,
	},
};

test("public catalog uses provider opencodex, exact hub ids, and honest image flags", () => {
	const models = parseHubModels({
		object: "list",
		data: [astra, sol, claude, textOnly],
	});
	expect(models.map((m) => m.id)).toEqual([
		"gpt-6-astra",
		"gpt-5.6-sol",
		"anthropic/claude-fable-5-1",
		"cursor/composer-2.5-fast",
	]);
	expect(models.every((m) => m.provider === "opencodex")).toBe(true);
	expect(models[0]?.imageInput).toBe(true);
	expect(models[1]?.imageInput).toBe(true);
	expect(models[2]?.imageInput).toBeUndefined();
	expect(models[3]?.imageInput).toBeUndefined();
	expect(models[2]?.reasoning).toBe(true);
	expect(models[3]?.reasoning).toBe(false);
	expect(models.every((m) => m.supportedRoles === undefined)).toBe(true);
	expect(models[1]?.maxOutputTokens).toBe(128000);
});

test("structurally invalid catalog payloads fail closed", () => {
	expect(() => parseHubModels(null)).toThrow();
	expect(() => parseHubModels({ data: "nope" })).toThrow();
	expect(
		parseHubModels({
			data: [
				{ id: "ok", capabilities: { context_length: 1000 } },
				{ id: "" },
				5,
			],
		}).map((m) => m.id),
	).toEqual(["ok"]);
});
test("explicit unsupported api_types drop the row instead of defaulting to Responses", () => {
	const models = parseHubModels({
		object: "list",
		data: [
			{
				id: "anthropic/claude-messages-only",
				api_types: ["anthropic_messages"],
				capabilities: { context_length: 200000 },
			},
			{
				id: "vendor/mystery-protocol",
				api_types: ["unknown_protocol"],
			},
			{
				id: "openai/chat-only",
				api_types: ["chat_completions"],
			},
			{
				id: "openai/responses-alias",
				api_types: ["openai_responses"],
			},
			{
				id: "openai/unspecified",
				capabilities: { context_length: 8000 },
			},
			{
				id: "openai/empty-types",
				api_types: [],
			},
		],
	});
	expect(models.map((m) => m.id)).toEqual([
		"openai/chat-only",
		"openai/responses-alias",
		"openai/unspecified",
	]);
	expect(models[0]?.endpoint).toBe("chat");
	expect(models[1]?.endpoint).toBe("responses");
	expect(models[2]?.endpoint).toBe("responses");
});

test("derived native catalog preserves exact routed and speed alias IDs for Responses", () => {
	const models = parseHubModels({
		data: [
			claude,
			textOnly,
			{ id: "gpt-5.6-sol--fast", api_types: ["responses"] },
			{ id: "only-chat", api_types: ["chat_completions"] },
		],
	});
	const native = JSON.parse(deriveNativeCatalog(models)) as {
		models: { slug: string }[];
	};
	expect(native.models.map((m) => m.slug)).toEqual([
		claude.id,
		textOnly.id,
		"gpt-5.6-sol--fast",
	]);
});

test("local native metadata cannot hide current Hub aliases or retain disconnected models", async () => {
	const { mergeNativeCatalog } = await import("../src/catalog.ts");
	const models = parseHubModels({
		data: [
			{ id: "vendor/root", api_types: ["responses"] },
			{ id: "vendor/root--fast", api_types: ["responses"] },
		],
	});
	const result = JSON.parse(
		mergeNativeCatalog(
			JSON.stringify({
				models: [
					{ slug: "vendor/root", description: "native metadata" },
					{ slug: "retired/model" },
				],
			}),
			models,
		),
	) as { models: { slug: string; description: string }[] };
	expect(result.models.map((m) => m.slug)).toEqual([
		"vendor/root",
		"vendor/root--fast",
	]);
	expect(result.models[0]?.description).toBe("native metadata");
});
