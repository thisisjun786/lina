import type { ModelReasoning } from "../../lina-runtime/src/models/types.ts";
import type { CompletionEndpoint } from "./catalog.ts";
import {
	COMPLETION_MAX_BYTES,
	COMPLETION_TIMEOUT_MS,
	type CompletionResult,
	type FetchLike,
	type HubRequest,
	hubSend,
	readCompletion,
} from "./client.ts";
import { OpenCodexError } from "./errors.ts";

export type CompleteMessage = {
	role: "user" | "assistant";
	content:
		| string
		| Array<
				| { type: "input_text"; text: string }
				| { type: "input_image"; image_url: string }
		  >;
};

export type CompleteRequest = {
	origin: string;
	token?: string | null;
	model: string;
	endpoint: CompletionEndpoint;
	systemPrompt?: string;
	messages: CompleteMessage[];
	reasoning?: ModelReasoning;
	maxOutputTokens?: number;
	signal: AbortSignal;
	fetchImpl?: FetchLike;
	/** Trusted in-process capability, excluded from both wire payloads. */
	beforeDispatch?: () => void;
};

function textParts(text: string): Array<{ type: "input_text"; text: string }> {
	return [{ type: "input_text", text }];
}

export function responsesPayload(
	request: CompleteRequest,
): Record<string, unknown> {
	const input = request.messages.map((message) => ({
		role: message.role,
		content:
			typeof message.content === "string"
				? message.role === "assistant"
					? [{ type: "output_text", text: message.content }]
					: textParts(message.content)
				: message.content,
	}));
	const body: Record<string, unknown> = {
		model: request.model,
		stream: true,
		store: false,
		input,
	};
	if (request.systemPrompt?.trim()) body["instructions"] = request.systemPrompt;
	if (request.reasoning && request.reasoning !== "off")
		body["reasoning"] = { effort: request.reasoning };
	if (request.maxOutputTokens !== undefined)
		body["max_output_tokens"] = request.maxOutputTokens;
	return body;
}

export function chatPayload(request: CompleteRequest): Record<string, unknown> {
	const messages: Array<Record<string, unknown>> = [];
	if (request.systemPrompt?.trim())
		messages.push({ role: "system", content: request.systemPrompt });
	for (const message of request.messages) {
		if (typeof message.content === "string") {
			messages.push({ role: message.role, content: message.content });
			continue;
		}
		messages.push({
			role: message.role,
			content: message.content.map((part) =>
				part.type === "input_text"
					? { type: "text", text: part.text }
					: { type: "image_url", image_url: { url: part.image_url } },
			),
		});
	}
	const body: Record<string, unknown> = {
		model: request.model,
		stream: true,
		messages,
	};
	if (request.reasoning && request.reasoning !== "off")
		body["reasoning_effort"] = request.reasoning;
	if (request.maxOutputTokens !== undefined)
		body["max_tokens"] = request.maxOutputTokens;
	return body;
}

export async function complete(
	request: CompleteRequest,
): Promise<CompletionResult> {
	if (!request.model.trim())
		throw new OpenCodexError(
			"model_unavailable",
			"Selected model is not available in the OpenCodex catalog",
		);
	const path =
		request.endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses";
	const body =
		request.endpoint === "chat"
			? chatPayload(request)
			: responsesPayload(request);
	const send: HubRequest = {
		origin: request.origin,
		path,
		method: "POST",
		body,
		accept: "text/event-stream",
		signal: request.signal,
		timeoutMs: COMPLETION_TIMEOUT_MS,
	};
	if (request.token) send.token = request.token;
	if (request.fetchImpl) send.fetchImpl = request.fetchImpl;
	if (request.beforeDispatch !== undefined)
		send.beforeDispatch = request.beforeDispatch;
	const response = await hubSend(send);
	return readCompletion(
		response,
		COMPLETION_MAX_BYTES,
		request.token ? [request.token] : [],
	);
}

export function imageDataUrl(bytes: Uint8Array, mimeType: string): string {
	return (
		"data:" + mimeType + ";base64," + Buffer.from(bytes).toString("base64")
	);
}
