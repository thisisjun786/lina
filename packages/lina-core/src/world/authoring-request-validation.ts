import {
	authoringText,
	MAX_EVALUATION_OPERATIONS,
	MAX_EXPRESSION_DEPTH,
	scalar,
} from "./authoring-node-validation.ts";
import type {
	EvaluationInput,
	EvaluationLimits,
	LifeConfigInput,
	LifeConfigInputV1,
	WorldConfirmation,
	WorldDraftCursor,
	WorldDraftInput,
	WorldPreviewOptions,
	WorldSuggestionRequest,
} from "./authoring-types.ts";
import {
	array,
	digest,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	nullableId,
	revision,
} from "./life-json.ts";
import { parseLifeViewLimits } from "./life-validation.ts";
import { parseLifeModelSelector } from "./model-selection.ts";
import { fields } from "./validation.ts";
import { parseWorkConfig } from "./work-validation.ts";

export function parseEvaluationLimits(value: unknown): EvaluationLimits {
	jsonBoundary(value);
	fields(value, ["maxChars", "maxRecords", "maxDepth", "maxOperations"]);
	const limits = {
		...parseLifeViewLimits({
			maxChars: value.maxChars,
			maxRecords: value.maxRecords,
		}),
		maxDepth: revision(value.maxDepth),
		maxOperations: revision(value.maxOperations, 1),
	};
	if (
		limits.maxDepth > MAX_EXPRESSION_DEPTH ||
		limits.maxOperations > MAX_EVALUATION_OPERATIONS
	)
		throw Error("Invalid authoring evaluation budget");
	return limits;
}
/** text is already scoped perception supplied by the trusted caller, never authored background. */
export function parseEvaluationInput(value: unknown): EvaluationInput {
	jsonBoundary(value);
	fields(value, [
		"worldId",
		"agentId",
		"targetAgentId",
		"recipientId",
		"evaluationId",
		"seed",
		"text",
		"variables",
		"limits",
	]);
	const variables = value.variables;
	if (!variables || typeof variables !== "object" || Array.isArray(variables))
		throw Error("Invalid authoring variables");
	return {
		worldId: identifier(value.worldId),
		agentId: identifier(value.agentId),
		targetAgentId: nullableId(value.targetAgentId),
		recipientId: nullableId(value.recipientId),
		evaluationId: identifier(value.evaluationId),
		seed: authoringText(value.seed),
		text: authoringText(value.text, true),
		variables: Object.fromEntries(
			Object.entries(variables).map(([key, item]) => [
				identifier(key),
				scalar(item),
			]),
		),
		limits: parseEvaluationLimits(value.limits),
	};
}
function nullable<T>(value: unknown, parse: (item: unknown) => T): T | null {
	return value === null ? null : parse(value);
}
function model(value: unknown) {
	fields(value, ["provider", "model"]);
	return {
		provider: authoringText(value.provider),
		model: authoringText(value.model),
	};
}
function mode(value: unknown): "manual" | "automatic" {
	return enumeration(value, ["manual", "automatic"]);
}
export function parseLifeConfigInput(value: unknown): LifeConfigInput {
	jsonBoundary(value);
	if (
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 2
	) {
		if (!("models" in value)) throw Error("Missing model configuration");
		if (!("work" in value)) throw Error("Missing work configuration");
		const { work, version: _version, ...rest } = value;
		return {
			...parseLifeConfigV1({ ...rest, models: null, version: 1 }),
			models: nullable(value.models, (item) => {
				fields(item, ["director", "actor"]);
				return {
					director: nullable(item.director, parseLifeModelSelector),
					actor: nullable(item.actor, parseLifeModelSelector),
				};
			}),
			version: 2,
			work: work === null ? null : parseWorkConfig(work),
		};
	}
	return parseLifeConfigV1(value);
}
function parseLifeConfigV1(value: unknown): LifeConfigInputV1 {
	jsonBoundary(value);
	fields(value, [
		"version",
		"clock",
		"run",
		"models",
		"limits",
		"usage",
		"publication",
		"images",
		"avatars",
	]);
	if (value.version !== 1) throw Error("Unsupported LIFE config version");
	return {
		version: 1,
		clock: nullable(value.clock, (item) => {
			fields(item, ["stepSize", "intervalMs", "maxCatchUpSteps"]);
			return {
				stepSize: revision(item.stepSize, 1),
				intervalMs: nullable(item.intervalMs, (x) => revision(x, 1)),
				maxCatchUpSteps: revision(item.maxCatchUpSteps),
			};
		}),
		run: nullable(value.run, (item) => {
			fields(item, ["mode"]);
			return {
				mode: enumeration(item.mode, ["paused", "manual", "automatic"]),
			};
		}),
		models: nullable(value.models, (item) => {
			fields(item, ["director", "actor"]);
			return {
				director: nullable(item.director, model),
				actor: nullable(item.actor, model),
			};
		}),
		limits: nullable(value.limits, (item) => {
			fields(item, [
				"maxActorActions",
				"maxCausalDepth",
				"maxModelCalls",
				"evaluation",
			]);
			return {
				maxActorActions: revision(item.maxActorActions),
				maxCausalDepth: revision(item.maxCausalDepth),
				maxModelCalls: revision(item.maxModelCalls),
				evaluation: parseEvaluationLimits(item.evaluation),
			};
		}),
		usage: nullable(value.usage, (item) => {
			fields(item, [
				"windowMs",
				"maxInputTokens",
				"maxOutputTokens",
				"maxImages",
			]);
			return {
				windowMs: revision(item.windowMs, 1),
				maxInputTokens: revision(item.maxInputTokens),
				maxOutputTokens: revision(item.maxOutputTokens),
				maxImages: revision(item.maxImages),
			};
		}),
		publication: nullable(value.publication, (item) => {
			fields(item, ["mode", "recipientIds"]);
			return {
				mode: mode(item.mode),
				recipientIds: identifiers(item.recipientIds),
			};
		}),
		images: nullable(value.images, (item) => {
			fields(item, ["mode", "maxPerStep"]);
			return { mode: mode(item.mode), maxPerStep: revision(item.maxPerStep) };
		}),
		avatars: nullable(value.avatars, (item) => {
			fields(item, ["mode", "intervalMs", "maxPerWindow"]);
			return {
				mode: mode(item.mode),
				intervalMs: nullable(item.intervalMs, (x) => revision(x, 1)),
				maxPerWindow: revision(item.maxPerWindow),
			};
		}),
	};
}
export function parseWorldDraftInput(value: unknown): WorldDraftInput {
	jsonBoundary(value);
	fields(value, ["worldId", "authoredText"]);
	return {
		worldId: identifier(value.worldId),
		authoredText: authoringText(value.authoredText),
	};
}
export function parseWorldDraftCursor(value: unknown): WorldDraftCursor {
	jsonBoundary(value);
	fields(value, ["afterId", "limit"]);
	const limit = revision(value.limit, 1);
	if (limit > 4096) throw Error("Invalid authoring page capacity");
	return { afterId: nullableId(value.afterId), limit };
}
export function parseWorldPreviewOptions(value: unknown): WorldPreviewOptions {
	jsonBoundary(value);
	fields(value, [
		"expectedWorldRevision",
		"simulationTime",
		"agentId",
		"targetAgentId",
		"seed",
		"limits",
		"relocations",
	]);
	return {
		expectedWorldRevision: nullable(value.expectedWorldRevision, revision),
		simulationTime: revision(value.simulationTime),
		agentId: identifier(value.agentId),
		targetAgentId: nullableId(value.targetAgentId),
		seed: authoringText(value.seed),
		limits: parseEvaluationLimits(value.limits),
		relocations: keyed(
			array(value.relocations, (item) => {
				fields(item, ["agentId", "sceneId"]);
				return {
					agentId: identifier(item.agentId),
					sceneId: nullableId(item.sceneId),
				};
			}),
			(x) => x.agentId,
		),
	};
}
export function parseWorldConfirmation(value: unknown): WorldConfirmation {
	jsonBoundary(value);
	fields(value, [
		"draftId",
		"expectedRevision",
		"idempotencyKey",
		"packDigest",
		"previewDigest",
		"options",
	]);
	return {
		draftId: identifier(value.draftId),
		expectedRevision: revision(value.expectedRevision, 1),
		idempotencyKey: identifier(value.idempotencyKey),
		packDigest: digest(value.packDigest),
		previewDigest: digest(value.previewDigest),
		options: parseWorldPreviewOptions(value.options),
	};
}
export function parseWorldSuggestionRequest(
	value: unknown,
): WorldSuggestionRequest {
	jsonBoundary(value);
	fields(value, [
		"requestId",
		"draftId",
		"draftRevision",
		"agentId",
		"modelSettingsRevision",
	]);
	return {
		requestId: identifier(value.requestId),
		draftId: identifier(value.draftId),
		draftRevision: revision(value.draftRevision, 1),
		agentId: identifier(value.agentId),
		modelSettingsRevision: revision(value.modelSettingsRevision, 1),
	};
}
