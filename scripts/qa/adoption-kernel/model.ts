import type {
	ChatMessage,
	ModelTransport,
	TransportConfig,
	TransportResult,
} from "./harness-types.ts";

type CompletionResponse = {
	model?: unknown;
	choices?: unknown;
	usage?: unknown;
};

function validateConfig(config: TransportConfig): void {
	if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
		throw Error("baseUrl must be a non-empty string");
	}
	if (typeof config.model !== "string" || config.model.length === 0) {
		throw Error("model must be a non-empty string");
	}
	if (typeof config.apiKey !== "string" || config.apiKey.length === 0) {
		throw Error("apiKey must be a non-empty string");
	}
	if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 0) {
		throw Error("timeoutMs must be a non-negative finite number");
	}
	if (config.maxOutputTokens !== 4096) {
		throw Error("maxOutputTokens must be 4096");
	}
	if (config.temperature !== 0) {
		throw Error("temperature must be 0");
	}
	if (config.fetch !== undefined && typeof config.fetch !== "function") {
		throw Error("fetch must be a function");
	}
}

function failure(
	reason: Extract<TransportResult, { kind: "transport-failure" }>["reason"],
	detail: string,
	startedAt: number,
	status?: number,
): TransportResult {
	return {
		kind: "transport-failure",
		reason,
		...(status === undefined ? {} : { status }),
		detail,
		latencyMs: performance.now() - startedAt,
	};
}

function usageValue(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value) &&
		value >= 0
		? value
		: null;
}

function decodeResponse(value: unknown): {
	content: string;
	model: string;
	usage: { prompt: number; completion: number };
} | null {
	if (!value || typeof value !== "object") return null;
	const record = value as CompletionResponse;
	if (
		!Array.isArray(record.choices) ||
		!record.choices[0] ||
		typeof record.choices[0] !== "object"
	) {
		return null;
	}
	const choice = record.choices[0] as { message?: unknown };
	if (!choice.message || typeof choice.message !== "object") return null;
	const message = choice.message as { content?: unknown };
	if (typeof message.content !== "string" || typeof record.model !== "string")
		return null;
	if (!record.usage || typeof record.usage !== "object") return null;
	const usage = record.usage as {
		prompt_tokens?: unknown;
		completion_tokens?: unknown;
	};
	const prompt = usageValue(usage.prompt_tokens);
	const completion = usageValue(usage.completion_tokens);
	return prompt === null || completion === null
		? null
		: {
				content: message.content,
				model: record.model,
				usage: { prompt, completion },
			};
}

export function createTransport(config: TransportConfig): ModelTransport {
	validateConfig(config);
	const request = config.fetch ?? globalThis.fetch;
	if (typeof request !== "function") throw Error("fetch is unavailable");

	return {
		async complete(
			messages: ChatMessage[],
			externalSignal?: AbortSignal,
		): Promise<TransportResult> {
			const startedAt = performance.now();
			const timeout = new AbortController();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				timeout.abort();
			}, config.timeoutMs);
			const signal = externalSignal
				? AbortSignal.any([externalSignal, timeout.signal])
				: timeout.signal;
			let removeAbortListener: (() => void) | undefined;
			const aborted = new Promise<never>((_resolve, reject) => {
				const onAbort = () => reject(new DOMException("aborted", "AbortError"));
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
				removeAbortListener = () =>
					signal.removeEventListener("abort", onAbort);
			});

			try {
				const fetchPromise = request(`${config.baseUrl}/chat/completions`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						model: config.model,
						messages,
						temperature: 0,
						max_tokens: 4096,
						stream: false,
					}),
					signal,
				});
				fetchPromise.catch(() => {});
				const response = await Promise.race([fetchPromise, aborted]);
				if (!response.ok)
					return failure("http", "request failed", startedAt, response.status);
				const jsonPromise = response.json();
				jsonPromise.catch(() => {});
				let body: unknown;
				try {
					body = await Promise.race([jsonPromise, aborted]);
				} catch (error) {
					if (signal.aborted) throw error;
					return failure("decode", "invalid response", startedAt);
				}
				const decoded = decodeResponse(body);
				if (!decoded) return failure("decode", "invalid response", startedAt);
				const requestId = response.headers.get("x-request-id") ?? undefined;
				return {
					kind: "ok",
					...decoded,
					latencyMs: performance.now() - startedAt,
					...(requestId ? { requestId } : {}),
				};
			} catch {
				if (timedOut) return failure("timeout", "request timed out", startedAt);
				return failure(
					"network",
					signal.aborted ? "request aborted" : "request failed",
					startedAt,
				);
			} finally {
				clearTimeout(timer);
				removeAbortListener?.();
			}
		},
	};
}
