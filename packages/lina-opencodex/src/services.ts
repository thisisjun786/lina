import { conservativeEstimator } from "../../lina-runtime/src/context/budget.ts";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type {
	ModelControl,
	ModelTrial,
} from "../../lina-runtime/src/models/port.ts";
import {
	type ModelRouteResult,
	resolveModelRoute,
} from "../../lina-runtime/src/models/routes.ts";
import type {
	ModelProfile,
	ModelRole,
	ModelRouteRequest,
	ModelSettings,
} from "../../lina-runtime/src/models/types.ts";
import { type HubModel, publicCatalog } from "./catalog.ts";
import type { FetchLike } from "./client.ts";
import { type CompleteRequest, complete, imageDataUrl } from "./complete.ts";
import { OpenCodexError } from "./errors.ts";
import {
	CONSOLIDATE_PROMPT,
	OBSERVE_PROMPT,
	PERSONA_INTERPRETATION_PROMPT,
	RECALL_PROMPT,
	REFLECT_PREFERENCES_PROMPT,
	REFLECT_PROMPT,
	RESOURCE_MEMORY_PROMPT,
	RESOURCE_PLAN_PROMPT,
	RESOURCE_RANK_PROMPT,
	RESOURCE_SUMMARY_PROMPT,
	SUMMARY_PROMPT,
	TEST_PROMPT,
	VISION_PROMPT,
} from "./prompts.ts";

const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
const RESERVE_TOKENS = 16_384;

export type SettingsGetter = () => ModelSettings | undefined;

export type OpenCodexRuntime = {
	origin: () => string;
	token: () => string | null;
	models: () => HubModel[];
	fetchImpl?: FetchLike;
};

function estimateText(text: string): number {
	return conservativeEstimator.text(text);
}

function catalogModel(
	models: readonly HubModel[],
	id: string,
): HubModel | undefined {
	return models.find((model) => model.id === id);
}

function requireResolved(
	runtime: OpenCodexRuntime,
	settings: ModelSettings | undefined,
	role: ModelRole,
	agentId: string | undefined,
	routeRequest?: ModelRouteRequest,
): { profile: ModelProfile; model: HubModel; route: ModelRouteResult } {
	if (!settings)
		throw new OpenCodexError(
			"not_configured",
			"No model settings are configured",
		);
	const route = resolveModelRoute(settings, role, agentId, routeRequest);
	const profile = route?.profile;
	if (!profile || !route)
		throw new OpenCodexError(
			"not_configured",
			"No model is configured for the " + role + " role",
		);
	if (profile.provider !== "opencodex")
		throw new OpenCodexError(
			"model_unavailable",
			"OpenCodex only serves provider=opencodex profiles",
		);
	const model = catalogModel(runtime.models(), profile.model);
	if (
		!model ||
		!model.authenticated ||
		(model.supportedRoles && !model.supportedRoles.includes(role))
	)
		throw new OpenCodexError(
			"model_unavailable",
			"Selected model is not available in the OpenCodex catalog: " +
				profile.model,
		);
	return { profile, model, route };
}

function appliedOptions(
	profile: ModelProfile,
	model: HubModel,
	maxTokens?: number,
) {
	if (
		maxTokens !== undefined &&
		(!Number.isSafeInteger(maxTokens) || maxTokens < 1)
	)
		throw new OpenCodexError("invalid_input", "Invalid caller output budget");
	if (
		profile.maxOutputTokens !== undefined &&
		profile.maxOutputTokens > model.maxOutputTokens
	)
		throw new OpenCodexError(
			"output_budget_exceeded",
			"Configured output budget exceeds the current model limit",
		);
	if (
		model.reasoning &&
		profile.reasoning !== "off" &&
		model.reasoningEfforts &&
		!model.reasoningEfforts.includes(profile.reasoning)
	)
		throw new OpenCodexError(
			"reasoning_unsupported",
			"Selected reasoning effort is not supported by the current model",
		);
	const applied: Pick<ModelProfile, "reasoning" | "maxOutputTokens"> = {
		reasoning: model.reasoning ? profile.reasoning : "off",
	};
	if (profile.maxOutputTokens !== undefined)
		applied.maxOutputTokens = profile.maxOutputTokens;
	if (maxTokens !== undefined)
		applied.maxOutputTokens = Math.min(
			maxTokens,
			profile.maxOutputTokens ?? model.maxOutputTokens,
			model.maxOutputTokens,
		);
	const reasoningStatus = !model.reasoning
		? ("model_no_reasoning" as const)
		: profile.reasoning === "off"
			? ("omitted" as const)
			: model.reasoningEfforts
				? ("verified" as const)
				: ("unverified" as const);
	return {
		requested: {
			reasoning: profile.reasoning,
			...(profile.maxOutputTokens !== undefined
				? { maxOutputTokens: profile.maxOutputTokens }
				: {}),
		},
		applied,
		reasoningStatus,
	};
}

function completeOptions(
	runtime: OpenCodexRuntime,
	profile: ModelProfile,
	model: HubModel,
	signal: AbortSignal,
	systemPrompt: string,
	messages: CompleteRequest["messages"],
	beforeDispatch?: () => void,
	maxTokens?: number,
): CompleteRequest {
	const { applied } = appliedOptions(profile, model, maxTokens);
	const request: CompleteRequest = {
		origin: runtime.origin(),
		model: profile.model,
		endpoint: model.endpoint,
		systemPrompt,
		messages,
		signal,
	};
	const token = runtime.token();
	if (beforeDispatch !== undefined) request.beforeDispatch = beforeDispatch;
	if (token) request.token = token;
	if (runtime.fetchImpl) request.fetchImpl = runtime.fetchImpl;
	if (applied.reasoning !== "off") request.reasoning = applied.reasoning;
	if (applied.maxOutputTokens !== undefined)
		request.maxOutputTokens = applied.maxOutputTokens;
	return request;
}

export function createOpenCodexModelControl(
	runtime: OpenCodexRuntime,
	settingsGetter: SettingsGetter,
	agentId?: string,
): ModelControl {
	return {
		catalog: () => publicCatalog(runtime.models()),
		state: () => {
			const settings = settingsGetter();
			try {
				const resolved = requireResolved(
					runtime,
					settings,
					"conversation",
					agentId,
				);
				return {
					provider: "opencodex",
					model: resolved.model.id,
					settingsRevision: settings?.revision ?? 0,
					error: null,
				};
			} catch (error) {
				return {
					provider: "opencodex",
					model: "",
					settingsRevision: settings?.revision ?? 0,
					error:
						error instanceof Error
							? error.message
							: "OpenCodex model is unavailable",
				};
			}
		},
		async authoring(input, signal) {
			signal.throwIfAborted();
			if (
				!input.systemPrompt.trim() ||
				input.systemPrompt.length > 48000 ||
				!input.messages.length ||
				input.messages.length > 24 ||
				input.messages.at(-1)?.role !== "user" ||
				input.messages.some(
					(message) =>
						!["user", "assistant"].includes(message.role) ||
						!message.content.trim(),
				) ||
				input.messages.reduce((n, message) => n + message.content.length, 0) >
					28000
			)
				throw new OpenCodexError("invalid_input", "Invalid authoring input");
			const settings = settingsGetter();
			if (
				input.expectedSettingsRevision !== undefined &&
				(!Number.isSafeInteger(input.expectedSettingsRevision) ||
					settings?.revision !== input.expectedSettingsRevision)
			)
				throw new OpenCodexError(
					"invalid_input",
					"Authoring model settings revision conflict",
				);
			const resolved = requireResolved(
				runtime,
				settings,
				"conversation",
				input.agentId,
			);
			const reply = await complete(
				completeOptions(
					runtime,
					resolved.profile,
					resolved.model,
					AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
					input.systemPrompt,
					input.messages,
					input.beforeDispatch,
				),
			);
			if (!reply.text.trim())
				throw new OpenCodexError(
					"empty_response",
					"모델이 빈 응답을 반환했습니다.",
				);
			return {
				provider: "opencodex",
				model: resolved.model.id,
				text: reply.text,
			};
		},
		async test(profile, prompt, signal) {
			if (!prompt.trim() || prompt.length > 8000)
				throw new OpenCodexError(
					"invalid_input",
					"Test prompt must contain 1-8000 characters",
				);
			signal.throwIfAborted();
			if (profile.provider !== "opencodex")
				throw new OpenCodexError(
					"model_unavailable",
					"OpenCodex only serves provider=opencodex profiles",
				);
			const model = catalogModel(runtime.models(), profile.model);
			if (!model)
				throw new OpenCodexError(
					"model_unavailable",
					"Selected model is not available in the OpenCodex catalog: " +
						profile.model,
				);
			const started = Date.now();
			const reply = await complete(
				completeOptions(
					runtime,
					profile,
					model,
					AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
					TEST_PROMPT,
					[{ role: "user", content: prompt }],
				),
			);
			const trial: ModelTrial = {
				provider: "opencodex",
				model: profile.model,
				text: reply.text.slice(0, 16000),
				durationMs: Date.now() - started,
				inputTokens: reply.inputTokens,
				outputTokens: reply.outputTokens,
			};
			return trial;
		},
	};
}

export function createOpenCodexContextServices(
	runtime: OpenCodexRuntime,
	settingsGetter: SettingsGetter,
	agentId?: string,
	systemPrompt = "",
): ContextServices {
	const resourceFrame = (prompt: string, text: string) => [
		{ role: "system" as const, content: prompt },
		{ role: "user" as const, content: text },
	];
	const assertResourceInput = (
		prompt: string,
		text: string,
		maxInputTokens?: number,
	) => {
		if (maxInputTokens === undefined) return;
		if (!Number.isSafeInteger(maxInputTokens) || maxInputTokens < 1)
			throw new OpenCodexError("invalid_input", "Invalid caller input budget");
		const used = conservativeEstimator.messages(resourceFrame(prompt, text));
		if (used > maxInputTokens)
			throw new OpenCodexError(
				"invalid_input",
				"Resource input exceeds the caller input budget",
			);
	};
	const roleCall = async (
		role: ModelRole,
		prompt: string,
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
		maxTokens?: number,
		routeRequest?: ModelRouteRequest,
		maxInputTokens?: number,
	) => {
		const resolved = requireResolved(
			runtime,
			settingsGetter(),
			role,
			agentId,
			routeRequest,
		);
		assertResourceInput(prompt, text, maxInputTokens);
		const request = completeOptions(
			runtime,
			resolved.profile,
			resolved.model,
			signal,
			prompt,
			[{ role: "user", content: text }],
			beforeDispatch,
			maxTokens,
		);
		const reply = await complete(request);
		return reply.text;
	};
	const conversationWindow = () => {
		try {
			return requireResolved(runtime, settingsGetter(), "conversation", agentId)
				.model.contextWindow;
		} catch {
			return 128_000;
		}
	};
	const services: ContextServices = {
		estimateText,
		estimator: conservativeEstimator,
		estimateMessages: conservativeEstimator.messages,
		systemTokens: estimateText(systemPrompt),
		get contextWindow() {
			return conversationWindow();
		},
		reserveTokens: RESERVE_TOKENS,
		routeInfo(role, routeRequest, maxTokens) {
			const resolved = requireResolved(
				runtime,
				settingsGetter(),
				role,
				agentId,
				routeRequest,
			);
			return {
				mode: resolved.route.mode,
				settingsRevision: resolved.route.settingsRevision,
				...(resolved.route.tier !== undefined
					? { tier: resolved.route.tier }
					: {}),
				profileId: resolved.profile.id,
				provider: resolved.profile.provider,
				model: resolved.profile.model,
				...appliedOptions(resolved.profile, resolved.model, maxTokens),
			};
		},
		summaryCacheKey: () => {
			try {
				return JSON.stringify([
					"summary-v2",
					services.routeInfo?.("summary"),
					conversationWindow(),
				]);
			} catch (error) {
				return JSON.stringify([
					"summary-v2",
					settingsGetter()?.revision,
					error instanceof Error ? error.message : "unavailable",
					conversationWindow(),
				]);
			}
		},
		async summarize(text, maxTokens, signal, beforeDispatch, routeRequest) {
			return roleCall(
				"summary",
				SUMMARY_PROMPT,
				text,
				AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
				beforeDispatch,
				maxTokens,
				routeRequest,
			);
		},
		async observe(text, signal, beforeDispatch, routeRequest) {
			return roleCall(
				"observation",
				OBSERVE_PROMPT,
				text,
				signal,
				beforeDispatch,
				undefined,
				routeRequest,
			);
		},
		async reasonMemory(text, signal, beforeDispatch, routeRequest) {
			return roleCall(
				"recall",
				RECALL_PROMPT,
				text,
				signal,
				beforeDispatch,
				undefined,
				routeRequest,
			);
		},
		async consolidate(text, signal, beforeDispatch, routeRequest, maxTokens) {
			return roleCall(
				"reflection",
				CONSOLIDATE_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest,
			);
		},
		async interpretPersona(
			text,
			signal,
			beforeDispatch,
			routeRequest,
			maxTokens,
		) {
			return roleCall(
				"reflection",
				PERSONA_INTERPRETATION_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest,
			);
		},
		async reflect(text, signal, beforeDispatch, routeRequest) {
			const preferencesOnly = JSON.parse(text).preferencesOnly === true;
			return roleCall(
				"reflection",
				preferencesOnly ? REFLECT_PREFERENCES_PROMPT : REFLECT_PROMPT,
				text,
				AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
				beforeDispatch,
				undefined,
				routeRequest,
			);
		},
		async analyzeImage(input, signal, beforeDispatch, maxTokens) {
			signal.throwIfAborted();
			if (
				input.bytes.byteLength === 0 ||
				input.bytes.byteLength > IMAGE_MAX_BYTES
			)
				throw new OpenCodexError(
					"invalid_input",
					"Vision image must be 1 byte to 2 MiB",
				);
			if (!IMAGE_TYPES.has(input.mimeType))
				throw new OpenCodexError(
					"invalid_input",
					"Vision image MIME type is not supported",
				);
			const resolved = requireResolved(
				runtime,
				settingsGetter(),
				"vision",
				agentId,
			);
			if (resolved.model.imageInput !== true)
				throw new OpenCodexError(
					"vision_unavailable",
					"Vision analysis requires an authenticated image-capable model. Configure a vision model in model settings.",
				);
			const question = input.question
				? "User requested these image details:\n" + input.question
				: "Describe the image's observable contents and relevant details factually.";
			const reply = await complete(
				completeOptions(
					runtime,
					resolved.profile,
					resolved.model,
					AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
					VISION_PROMPT,
					[
						{
							role: "user",
							content: [
								{ type: "input_text", text: question },
								{
									type: "input_image",
									image_url: imageDataUrl(input.bytes, input.mimeType),
								},
							],
						},
					],
					beforeDispatch,
					maxTokens,
				),
			);
			if (!reply.text.trim())
				throw new OpenCodexError(
					"empty_response",
					"Vision analysis returned no visual evidence",
				);
			return {
				provider: "opencodex",
				model: resolved.model.id,
				text: reply.text,
			};
		},
		async deriveResourceMemory(
			text,
			signal,
			beforeDispatch,
			routeRequest,
			maxTokens,
			maxInputTokens,
		) {
			return roleCall(
				"observation",
				RESOURCE_MEMORY_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest ?? { tier: "standard" },
				maxInputTokens,
			);
		},
		memoryInputOverhead() {
			return conservativeEstimator.messages(
				resourceFrame(RESOURCE_MEMORY_PROMPT, ""),
			);
		},
		async summarizeResource(
			text,
			signal,
			beforeDispatch,
			routeRequest,
			maxTokens,
			maxInputTokens,
		) {
			return roleCall(
				"summary",
				RESOURCE_SUMMARY_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest,
				maxInputTokens,
			);
		},
		async planResources(
			text,
			signal,
			beforeDispatch,
			routeRequest,
			maxTokens,
			maxInputTokens,
		) {
			return roleCall(
				"recall",
				RESOURCE_PLAN_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest,
				maxInputTokens,
			);
		},
		async rankResources(
			text,
			signal,
			beforeDispatch,
			routeRequest,
			maxTokens,
			maxInputTokens,
		) {
			return roleCall(
				"recall",
				RESOURCE_RANK_PROMPT,
				text,
				signal,
				beforeDispatch,
				maxTokens,
				routeRequest,
				maxInputTokens,
			);
		},
		resourceInputOverhead(kind) {
			const prompt =
				kind === "summary"
					? RESOURCE_SUMMARY_PROMPT
					: kind === "plan"
						? RESOURCE_PLAN_PROMPT
						: RESOURCE_RANK_PROMPT;
			return conservativeEstimator.messages(resourceFrame(prompt, ""));
		},
		prepare(_event) {
			throw new OpenCodexError(
				"not_configured",
				"OpenCodex context services do not own native compaction; attach engine prepare at the session seam",
			);
		},
	};
	return services;
}
