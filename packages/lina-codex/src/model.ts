import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import { resolveProfile } from "../../lina-runtime/src/models/selection.ts";
import type { ModelReasoning } from "../../lina-runtime/src/models/types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ConversationTurnModel = {
	model: string;
	modelProvider: string;
	effort?: string;
};

type TurnOptions = Pick<SdkSessionOptions, "modelSettings" | "agentId"> & {
	models: ModelControl;
	model?: string;
	modelProvider?: string;
};

function catalogRows(catalog: unknown): Record<string, unknown>[] {
	if (!isRecord(catalog) || !Array.isArray(catalog["data"])) return [];
	return catalog["data"].flatMap((item) => (isRecord(item) ? [item] : []));
}

export function listedModelIds(catalog: unknown): string[] {
	return catalogRows(catalog).flatMap((item) => {
		const id = typeof item["id"] === "string" ? item["id"] : undefined;
		const model = typeof item["model"] === "string" ? item["model"] : undefined;
		return [id, model].filter((value): value is string => !!value);
	});
}

export function requireListedModel(catalog: unknown, model: string): void {
	if (!listedModelIds(catalog).includes(model))
		throw new Error(
			`Selected model is not available in the Codex model/list catalog: ${model}`,
		);
}

function catalogEntry(
	catalog: unknown,
	model: string,
): Record<string, unknown> | undefined {
	return catalogRows(catalog).find(
		(item) => item["id"] === model || item["model"] === model,
	);
}

function effortName(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (!isRecord(value)) return;
	const named = value["reasoningEffort"] ?? value["effort"] ?? value["level"];
	return typeof named === "string" && named.trim() ? named : undefined;
}

export function advertisedEfforts(catalog: unknown, model: string): string[] {
	const entry = catalogEntry(catalog, model);
	if (!entry) return [];
	const buckets = [
		entry["supportedReasoningEfforts"],
		entry["supported_reasoning_levels"],
		entry["supported_reasoning_efforts"],
	];
	const names: string[] = [];
	for (const bucket of buckets) {
		if (!Array.isArray(bucket)) continue;
		for (const item of bucket) {
			const name = effortName(item);
			if (name && !names.includes(name)) names.push(name);
		}
	}
	return names;
}

export function nativeEffort(
	catalog: unknown,
	model: string,
	reasoning?: ModelReasoning,
): string | undefined {
	const efforts = advertisedEfforts(catalog, model);
	if (!reasoning || reasoning === "off") return;
	if (efforts.length === 0) return;
	if (efforts.includes(reasoning)) return reasoning;
	throw new Error(
		`Selected reasoning ${reasoning} is not supported by ${model}; advertised efforts: ${efforts.join(", ")}`,
	);
}

export function conversationTurn(
	options: TurnOptions,
	catalog: unknown,
	boundProvider?: string,
): ConversationTurnModel {
	const settings = options.modelSettings?.();
	const profile = settings
		? resolveProfile(settings, "conversation", options.agentId)
		: null;
	const model = profile?.model ?? options.model ?? options.models.state().model;
	const modelProvider =
		profile?.provider ??
		options.modelProvider ??
		options.models.state().provider;
	if (boundProvider !== undefined && modelProvider !== boundProvider) {
		throw new Error(
			`Native turn/start cannot switch model provider from ${boundProvider} to ${modelProvider}`,
		);
	}
	requireListedModel(catalog, model);
	const effort = nativeEffort(catalog, model, profile?.reasoning);
	return {
		model,
		modelProvider,
		...(effort ? { effort } : {}),
	};
}
