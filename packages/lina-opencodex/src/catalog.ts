import type { CatalogModel } from "../../lina-runtime/src/models/port.ts";
import { OpenCodexError } from "./errors.ts";

export const MAX_MODELS = 2000;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

export type CompletionEndpoint = "responses" | "chat";

export type HubModel = CatalogModel & {
	endpoint: CompletionEndpoint;
	reasoningEfforts?: string[];
	defaultReasoning?: string;
};

function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function positiveInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const n = Math.floor(value);
	if (n > 0 && Number.isSafeInteger(n)) return n;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return;
	const items = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return items;
}

function imageInputOf(caps: Record<string, unknown> | null): true | undefined {
	if (!caps) return;
	if (caps["supports_vision"] === true) return true;
	if (caps["supports_vision"] === false) return;
	const modalities = stringList(caps["input_modalities"]);
	if (modalities?.includes("image")) return true;
}

function endpointOf(row: Record<string, unknown>): CompletionEndpoint | null {
	const raw = row["api_types"];
	if (raw === undefined || raw === null) return "responses";
	const types = stringList(raw);
	if (!types) return null;
	if (types.includes("responses") || types.includes("openai_responses"))
		return "responses";
	if (types.includes("chat_completions") || types.includes("openai_chat"))
		return "chat";
	return null;
}

function parseRow(raw: unknown): HubModel | null {
	const row = record(raw);
	if (!row) return null;
	const id = row["id"];
	if (
		typeof id !== "string" ||
		!id.trim() ||
		id.length > 256 ||
		hasControlChars(id)
	)
		return null;
	const caps = record(row["capabilities"]);
	const contextWindow =
		positiveInt(caps?.["context_length"]) ??
		positiveInt(row["context_window"]) ??
		DEFAULT_CONTEXT_WINDOW;
	const maxOutputTokens =
		positiveInt(caps?.["max_output_tokens"]) ??
		positiveInt(row["max_tokens"]) ??
		DEFAULT_MAX_OUTPUT_TOKENS;
	const efforts = caps?.["reasoning_effort"];
	const reasoning =
		caps?.["supports_reasoning"] === true ||
		(Array.isArray(efforts) && efforts.length > 0) ||
		row["supports_reasoning_effort"] === true;
	const endpoint = endpointOf(row);
	if (!endpoint) return null;
	const model: HubModel = {
		provider: "opencodex",
		id,
		name:
			typeof row["name"] === "string" && row["name"].trim() ? row["name"] : id,
		contextWindow,
		maxOutputTokens,
		reasoning,
		authenticated: true,
		endpoint,
	};
	const advertisedEfforts = stringList(efforts);
	if (advertisedEfforts?.length) model.reasoningEfforts = advertisedEfforts;
	const defaultEffort = row["reasoning_effort"];
	if (
		typeof defaultEffort === "string" &&
		advertisedEfforts?.includes(defaultEffort)
	)
		model.defaultReasoning = defaultEffort;
	if (imageInputOf(caps) === true) model.imageInput = true;
	return model;
}

export function parseHubModels(payload: unknown): HubModel[] {
	const body = record(payload);
	const data = body?.["data"];
	if (!Array.isArray(data))
		throw new OpenCodexError(
			"catalog_invalid",
			"OpenCodex model list was invalid",
		);
	if (data.length > MAX_MODELS)
		throw new OpenCodexError(
			"catalog_invalid",
			"OpenCodex model list exceeded the allowed size",
		);
	const models: HubModel[] = [];
	const seen = new Set<string>();
	for (const row of data) {
		const model = parseRow(row);
		if (!model || seen.has(model.id)) continue;
		seen.add(model.id);
		models.push(model);
	}
	return models;
}

export function publicCatalog(models: readonly HubModel[]): CatalogModel[] {
	return models.map((model) => {
		const item: CatalogModel = {
			provider: model.provider,
			id: model.id,
			name: model.name,
			contextWindow: model.contextWindow,
			maxOutputTokens: model.maxOutputTokens,
			reasoning: model.reasoning,
			authenticated: model.authenticated,
		};
		if (model.imageInput === true) item.imageInput = true;
		if (model.reasoningEfforts !== undefined)
			item.reasoningEfforts = [...model.reasoningEfforts];
		if (model.defaultReasoning !== undefined)
			item.defaultReasoning = model.defaultReasoning;
		return item;
	});
}

export function validateHubCatalog(payload: unknown): string {
	const body = record(payload);
	if (!body)
		throw new OpenCodexError(
			"catalog_invalid",
			"OpenCodex catalog response was invalid",
		);
	const models = body["models"];
	if (!Array.isArray(models) || models.length > MAX_MODELS)
		throw new OpenCodexError(
			"catalog_invalid",
			"OpenCodex catalog model list was invalid",
		);
	const slugs = new Set<string>();
	for (const row of models) {
		const item = record(row);
		const slug = item?.["slug"];
		if (
			typeof slug !== "string" ||
			!slug.trim() ||
			hasControlChars(slug) ||
			slugs.has(slug)
		)
			throw new OpenCodexError(
				"catalog_invalid",
				"OpenCodex catalog model slug was invalid",
			);
		slugs.add(slug);
	}
	return JSON.stringify(payload);
}

export function deriveNativeCatalog(models: readonly HubModel[]): string {
	const entries = models
		.filter((model) => model.endpoint === "responses")
		.map((model) => ({
			slug: model.id,
			display_name: model.name,
			description: "Model advertised by the configured OpenCodex Hub",
			base_instructions:
				"Follow the agent instructions supplied for this session.",
			supported_reasoning_levels: (model.reasoningEfforts ?? []).map(
				(effort) => ({ effort, description: effort }),
			),
			default_reasoning_level: model.defaultReasoning ?? null,
			shell_type: "unified_exec",
			priority: 0,
			support_verbosity: false,
			truncation_policy: { mode: "bytes", limit: 10000 },
			experimental_supported_tools: [],
			context_window: model.contextWindow,
			input_modalities:
				model.imageInput === true ? ["text", "image"] : ["text"],
			visibility: "list",
			supported_in_api: true,
		}));
	return JSON.stringify({ models: entries });
}

/** Hub membership is authoritative; native metadata enriches only current IDs. */
export function mergeNativeCatalog(
	metadata: string,
	models: readonly HubModel[],
): string {
	const native = JSON.parse(metadata) as { models: Record<string, unknown>[] };
	const byId = new Map(native.models.map((model) => [model["slug"], model]));
	const derived = JSON.parse(deriveNativeCatalog(models)) as {
		models: Record<string, unknown>[];
	};
	return JSON.stringify({
		models: derived.models.map((model) => ({
			...model,
			...byId.get(model["slug"]),
			slug: model["slug"],
		})),
	});
}
