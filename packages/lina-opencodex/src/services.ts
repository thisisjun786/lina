import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type {
	CatalogModel,
	ModelControl,
	ModelTrial,
} from "../../lina-runtime/src/models/port.ts";
import { resolveProfile } from "../../lina-runtime/src/models/selection.ts";
import type {
	ModelProfile,
	ModelRole,
	ModelSettings,
} from "../../lina-runtime/src/models/types.ts";
import type { HubModel } from "./catalog.ts";
import type { FetchLike } from "./client.ts";
import { type CompleteRequest, complete, imageDataUrl } from "./complete.ts";
import { OpenCodexError } from "./errors.ts";
import {
	OBSERVE_PROMPT,
	RECALL_PROMPT,
	REFLECT_PREFERENCES_PROMPT,
	REFLECT_PROMPT,
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
	return Math.ceil(text.length / 4);
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
): { profile: ModelProfile; model: HubModel } {
	if (!settings)
		throw new OpenCodexError(
			"not_configured",
			"No model settings are configured",
		);
	const profile = resolveProfile(settings, role, agentId);
	if (!profile)
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
	if (!model)
		throw new OpenCodexError(
			"model_unavailable",
			"Selected model is not available in the OpenCodex catalog: " +
				profile.model,
		);
	return { profile, model };
}

function completeOptions(
	runtime: OpenCodexRuntime,
	profile: ModelProfile,
	model: HubModel,
	signal: AbortSignal,
	systemPrompt: string,
	messages: CompleteRequest["messages"],
): CompleteRequest {
	const request: CompleteRequest = {
		origin: runtime.origin(),
		model: profile.model,
		endpoint: model.endpoint,
		systemPrompt,
		messages,
		signal,
	};
	const token = runtime.token();
	if (token) request.token = token;
	if (runtime.fetchImpl) request.fetchImpl = runtime.fetchImpl;
	if (model.reasoning && profile.reasoning !== "off")
		request.reasoning = profile.reasoning;
	if (profile.maxOutputTokens !== undefined)
		request.maxOutputTokens = profile.maxOutputTokens;
	return request;
}

export function createOpenCodexModelControl(
	runtime: OpenCodexRuntime,
	settingsGetter: SettingsGetter,
	agentId?: string,
): ModelControl {
	return {
		catalog: () =>
			runtime.models().map((model) => {
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
				return item;
			}),
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
			const resolved = requireResolved(
				runtime,
				settingsGetter(),
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
	const roleCall = async (
		role: ModelRole,
		prompt: string,
		text: string,
		signal: AbortSignal,
	) => {
		const resolved = requireResolved(runtime, settingsGetter(), role, agentId);
		const request = completeOptions(
			runtime,
			resolved.profile,
			resolved.model,
			signal,
			prompt,
			[{ role: "user", content: text }],
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
		estimateMessages: (messages) =>
			messages.reduce<number>((total, message) => {
				if (typeof message === "string") return total + estimateText(message);
				if (message && typeof message === "object" && "content" in message) {
					const content = (message as { content?: unknown }).content;
					if (typeof content === "string") return total + estimateText(content);
				}
				try {
					return total + estimateText(JSON.stringify(message));
				} catch {
					return total;
				}
			}, 0),
		systemTokens: estimateText(systemPrompt),
		get contextWindow() {
			return conversationWindow();
		},
		reserveTokens: RESERVE_TOKENS,
		summaryCacheKey: () => {
			const settings = settingsGetter();
			const profile = settings
				? resolveProfile(settings, "summary", agentId)
				: null;
			return JSON.stringify([
				"summary-v1",
				profile ?? { provider: "opencodex" },
				conversationWindow(),
			]);
		},
		async summarize(text, _maxTokens, signal) {
			return roleCall(
				"summary",
				SUMMARY_PROMPT,
				text,
				AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
			);
		},
		async observe(text, signal) {
			return roleCall("observation", OBSERVE_PROMPT, text, signal);
		},
		async reasonMemory(text, signal) {
			return roleCall("recall", RECALL_PROMPT, text, signal);
		},
		async reflect(text, signal) {
			const preferencesOnly = JSON.parse(text).preferencesOnly === true;
			return roleCall(
				"reflection",
				preferencesOnly ? REFLECT_PREFERENCES_PROMPT : REFLECT_PROMPT,
				text,
				AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
			);
		},
		async analyzeImage(input, signal) {
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
		prepare(_event) {
			throw new OpenCodexError(
				"not_configured",
				"OpenCodex context services do not own native compaction; attach engine prepare at the session seam",
			);
		},
	};
	return services;
}
