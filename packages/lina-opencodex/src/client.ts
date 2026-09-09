import { httpError, OpenCodexError, sanitizeMessage } from "./errors.ts";

export const MODELS_MAX_BYTES = 2 * 1024 * 1024;
export const CATALOG_MAX_BYTES = 64 * 1024 * 1024;
export const COMPLETION_MAX_BYTES = 1 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const COMPLETION_TIMEOUT_MS = 60_000;

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type HubRequest = {
	origin: string;
	path: string;
	method?: string;
	token?: string | null;
	body?: unknown;
	accept?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
	fetchImpl?: FetchLike;
	secrets?: readonly string[];
	/** Trusted synchronous capability; omission supplies no source-policy proof. */
	beforeDispatch?: () => void;
};

function combineSignals(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 0 ||
		timeoutMs > 4_294_967_295
	)
		throw new RangeError("Invalid OpenCodex request timeout");
	const controller = new AbortController();
	const combined = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	const timer = setTimeout(
		() =>
			controller.abort(new DOMException("Request timed out", "TimeoutError")),
		timeoutMs,
	);
	timer.unref();
	const dispose = () => {
		clearTimeout(timer);
		combined.removeEventListener("abort", dispose);
	};
	if (combined.aborted) dispose();
	else combined.addEventListener("abort", dispose, { once: true });
	return { signal: combined, dispose };
}

async function readBounded(
	response: Response,
	maxBytes: number,
): Promise<string> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes)
		throw new OpenCodexError(
			"body_too_large",
			"OpenCodex response exceeded the allowed size",
			response.status,
		);
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes)
				throw new OpenCodexError(
					"body_too_large",
					"OpenCodex response exceeded the allowed size",
					response.status,
				);
			chunks.push(value);
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new OpenCodexError(
			"body_invalid",
			"OpenCodex response was not valid UTF-8",
			response.status,
		);
	}
}

function isTimeoutOrAbort(error: unknown): boolean {
	if (error instanceof DOMException || error instanceof Error)
		return error.name === "AbortError" || error.name === "TimeoutError";
	return false;
}

function throwHubTransportError(
	error: unknown,
	signal: AbortSignal | undefined,
	secrets: readonly string[],
): never {
	if (signal?.aborted) signal.throwIfAborted();
	if (error instanceof OpenCodexError) throw error;
	if (isTimeoutOrAbort(error))
		throw new OpenCodexError(
			"timeout",
			sanitizeMessage("OpenCodex request timed out", secrets),
		);
	throw new OpenCodexError(
		"unreachable",
		sanitizeMessage("OpenCodex request did not complete", secrets),
	);
}

function jsonContentType(value: string): boolean {
	const type = value.split(";", 1)[0]?.trim().toLowerCase();
	return type === "application/json" || type?.endsWith("+json") === true;
}

export async function hubSend(request: HubRequest): Promise<Response> {
	const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const secrets = request.token
		? [request.token, ...(request.secrets ?? [])]
		: (request.secrets ?? []);
	const headers = new Headers();
	headers.set("Accept", request.accept ?? "application/json");
	if (request.token) headers.set("x-opencodex-api-key", request.token);
	if (request.body !== undefined)
		headers.set("Content-Type", "application/json");
	const url = request.origin + request.path;
	const fetchImpl = request.fetchImpl ?? fetch;
	const init: RequestInit = {
		method: request.method ?? "GET",
		headers,
		redirect: "manual",
	};
	let combined: ReturnType<typeof combineSignals>;
	try {
		if (request.body !== undefined) init.body = JSON.stringify(request.body);
		combined = combineSignals(request.signal, timeoutMs);
	} catch (error) {
		throwHubTransportError(error, request.signal, secrets);
	}
	init.signal = combined.signal;
	let response: Response;
	try {
		combined.signal.throwIfAborted();
		if (
			request.beforeDispatch !== undefined &&
			typeof request.beforeDispatch !== "function"
		)
			throw new OpenCodexError(
				"invalid_input",
				"Invalid provider dispatch check",
			);
		// No await or request preparation may separate this check from fetch.
		const result: unknown = request.beforeDispatch?.();
		if (result !== undefined) {
			// A void signature also accepts async functions in TS. Never await one here.
			if (result instanceof Promise) void result.catch(() => {});
			throw new OpenCodexError(
				"invalid_input",
				"Provider dispatch check must return synchronously without a value",
			);
		}
	} catch (error) {
		combined.dispose();
		throw error;
	}
	try {
		response = await fetchImpl(url, init);
	} catch (error) {
		combined.dispose();
		throwHubTransportError(error, request.signal, secrets);
	}
	if (
		response.status >= 300 &&
		response.status < 400 &&
		response.status !== 304
	)
		throw new OpenCodexError(
			"redirect_refused",
			"OpenCodex request redirect was refused",
			response.status,
		);
	return response;
}

export async function hubJson(
	request: HubRequest,
): Promise<{ status: number; json: unknown; headers: Headers }> {
	const response = await hubSend(request);
	const maxBytes = request.maxBytes ?? MODELS_MAX_BYTES;
	const contentType = response.headers.get("content-type") ?? "";
	if (response.status === 304)
		throw new OpenCodexError(
			"catalog_unexpected_304",
			"OpenCodex answered 304 to an unconditional request",
			304,
		);
	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {
			/* ignore */
		}
		if (response.status === 401)
			throw new OpenCodexError(
				"catalog_unauthorized",
				"OpenCodex API key required",
				401,
			);
		throw httpError(response.status, request.token ? [request.token] : []);
	}
	if (!jsonContentType(contentType)) {
		try {
			await response.body?.cancel();
		} catch {
			/* ignore */
		}
		throw new OpenCodexError(
			"catalog_content_type_invalid",
			"OpenCodex response was not JSON",
			response.status,
		);
	}
	const text = await readBounded(response, maxBytes);
	try {
		return {
			status: response.status,
			json: JSON.parse(text) as unknown,
			headers: response.headers,
		};
	} catch {
		throw new OpenCodexError(
			"catalog_invalid",
			"OpenCodex returned malformed JSON",
			response.status,
		);
	}
}

type SseAcc = {
	completed: boolean;
	delta: string;
	done: string;
	final: string | null;
	error: string | null;
	inputTokens: number;
	outputTokens: number;
};

function usageOf(value: unknown): { input: number; output: number } {
	const rec =
		value && typeof value === "object"
			? (value as Record<string, unknown>)
			: null;
	const input =
		typeof rec?.["input_tokens"] === "number"
			? rec["input_tokens"]
			: typeof rec?.["prompt_tokens"] === "number"
				? rec["prompt_tokens"]
				: 0;
	const output =
		typeof rec?.["output_tokens"] === "number"
			? rec["output_tokens"]
			: typeof rec?.["completion_tokens"] === "number"
				? rec["completion_tokens"]
				: 0;
	return { input, output };
}

function textFromOutput(output: unknown): string {
	if (!Array.isArray(output)) return "";
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const content = (item as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const type = (block as { type?: unknown }).type;
			const text = (block as { text?: unknown }).text;
			if (
				(type === "output_text" || type === "text") &&
				typeof text === "string"
			)
				parts.push(text);
		}
	}
	return parts.join("");
}

function handleSsePayload(payload: string, acc: SseAcc): void {
	if (!payload || payload === "[DONE]") return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload) as unknown;
	} catch {
		return;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
	const data = parsed as Record<string, unknown>;
	const type = data["type"];
	if (
		type === "response.output_text.delta" &&
		typeof data["delta"] === "string"
	)
		acc.delta += data["delta"];
	else if (
		type === "response.output_text.done" &&
		typeof data["text"] === "string"
	)
		acc.done += data["text"];
	else if (type === "response.completed" || type === "response.done") {
		const response = record(data["response"]);
		acc.completed = true;
		if (response) {
			acc.final = textFromOutput(response["output"]);
			const usage = usageOf(response["usage"]);
			acc.inputTokens = usage.input;
			acc.outputTokens = usage.output;
		}
	} else if (
		type === "response.failed" ||
		type === "response.incomplete" ||
		type === "error"
	) {
		const response = record(data["response"]);
		const err = record(data["error"]) ?? record(response?.["error"]);
		const message = err?.["message"];
		if (typeof message === "string") acc.error = message;
		else if (typeof data["message"] === "string") acc.error = data["message"];
		else acc.error = "Provider did not complete the response";
	}
	const choices = data["choices"];
	if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
		const choice = choices[0] as Record<string, unknown>;
		const delta = record(choice["delta"]);
		if (typeof delta?.["content"] === "string") acc.delta += delta["content"];
		if (choice["finish_reason"] === "stop") acc.completed = true;
		else if (choice["finish_reason"])
			acc.error = "Provider stopped before a complete text response";
		const message = record(choice["message"]);
		if (typeof message?.["content"] === "string")
			acc.done += message["content"];
		if (data["usage"]) {
			const usage = usageOf(data["usage"]);
			acc.inputTokens = usage.input;
			acc.outputTokens = usage.output;
		}
	}
}

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function jsonTerminalFailed(rec: Record<string, unknown> | null): boolean {
	if (!rec) return false;
	const err = rec["error"];
	if (typeof err === "string" && err.trim()) return true;
	if (err && typeof err === "object") return true;
	const status = rec["status"];
	if (status === "incomplete" || status === "failed" || status === "cancelled")
		return true;
	const incomplete = record(rec["incomplete_details"]);
	if (
		incomplete &&
		typeof incomplete["reason"] === "string" &&
		incomplete["reason"]
	)
		return true;
	const choices = rec["choices"];
	if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
		const reason = (choices[0] as Record<string, unknown>)["finish_reason"];
		if (typeof reason === "string" && reason !== "stop") return true;
	}
	return false;
}

export type CompletionResult = {
	text: string;
	inputTokens: number;
	outputTokens: number;
};

export async function readCompletion(
	response: Response,
	maxBytes: number,
	secrets: readonly string[] = [],
): Promise<CompletionResult> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!response.ok) {
		try {
			await response.body?.cancel();
		} catch {
			/* ignore */
		}
		throw httpError(response.status, secrets);
	}
	if (
		contentType.includes("application/json") &&
		!contentType.includes("event-stream")
	) {
		const text = await readBounded(response, maxBytes);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new OpenCodexError(
				"body_invalid",
				"OpenCodex returned malformed JSON",
				response.status,
			);
		}
		const rec = record(parsed);
		if (jsonTerminalFailed(rec))
			throw new OpenCodexError(
				"provider_error",
				sanitizeMessage("OpenCodex request failed", secrets),
			);
		const outputText =
			typeof rec?.["output_text"] === "string" ? rec["output_text"] : "";
		const fromOutput = textFromOutput(rec?.["output"]);
		const chat = Array.isArray(rec?.["choices"])
			? record(record(rec?.["choices"][0])?.["message"])?.["content"]
			: undefined;
		const textOut =
			outputText || fromOutput || (typeof chat === "string" ? chat : "");
		if (!textOut.trim())
			throw new OpenCodexError(
				"empty_response",
				"OpenCodex returned an empty response",
			);
		const usage = usageOf(rec?.["usage"]);
		return {
			text: textOut,
			inputTokens: usage.input,
			outputTokens: usage.output,
		};
	}
	if (!response.body)
		throw new OpenCodexError(
			"empty_response",
			"OpenCodex returned an empty response",
		);
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let buffer = "";
	let bytes = 0;
	const acc: SseAcc = {
		completed: false,
		delta: "",
		done: "",
		final: null,
		error: null,
		inputTokens: 0,
		outputTokens: 0,
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			if (bytes > maxBytes)
				throw new OpenCodexError(
					"body_too_large",
					"OpenCodex response exceeded the allowed size",
					response.status,
				);
			buffer += decoder.decode(value, { stream: true });
			buffer = buffer.replace(/\r\n/g, "\n");
			let sep = buffer.indexOf("\n\n");
			while (sep >= 0) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const dataLines = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart());
				if (dataLines.length) {
					const payload = dataLines.join("\n");
					if (payload === "[DONE]") {
						buffer = "";
						break;
					}
					handleSsePayload(payload, acc);
				}
				sep = buffer.indexOf("\n\n");
			}
			if (acc.error) break;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			/* ignore */
		}
	}
	if (acc.error || !acc.completed)
		throw new OpenCodexError(
			"provider_error",
			sanitizeMessage("OpenCodex request failed", secrets),
		);
	const text = (acc.final || acc.done || acc.delta).trim();
	if (!text)
		throw new OpenCodexError(
			"empty_response",
			"OpenCodex returned an empty response",
		);
	return { text, inputTokens: acc.inputTokens, outputTokens: acc.outputTokens };
}
