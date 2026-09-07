import { type FetchLike, OpenVikingRequestError } from "./types.ts";

export interface TransportOptions {
	baseUrl: string;
	apiKey: string;
	fetch: FetchLike;
	timeoutMs: number;
	bodyCapBytes: number;
}

export interface TransportResult {
	status: number;
	body: unknown;
}

const MAX_TIMEOUT_MS = 8000;

export class OpenVikingTransport {
	constructor(private readonly options: TransportOptions) {
		if (
			options.timeoutMs < 1 ||
			options.timeoutMs > MAX_TIMEOUT_MS ||
			options.bodyCapBytes < 1
		)
			throw new Error("invalid openviking client options");
	}

	private async readBody(response: Response): Promise<unknown> {
		const chunks: Uint8Array[] = [];
		let total = 0;
		const reader = response.body?.getReader();
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > this.options.bodyCapBytes) {
					await reader.cancel();
					throw new OpenVikingRequestError(
						"openviking response body too large",
						"body",
					);
				}
				chunks.push(value);
			}
		}
		const text = Buffer.concat(chunks).toString("utf8");
		try {
			return text ? JSON.parse(text) : null;
		} catch {
			throw new OpenVikingRequestError(
				"openviking response is not JSON",
				"body",
			);
		}
	}

	private errorMessage(body: unknown, status: number): string {
		if (typeof body === "object" && body !== null && !Array.isArray(body)) {
			const error = (body as Record<string, unknown>)["error"];
			if (
				typeof error === "object" &&
				error !== null &&
				!Array.isArray(error)
			) {
				const message = (error as Record<string, unknown>)["message"];
				if (typeof message === "string" && message.trim()) return message;
			}
		}
		return `openviking status ${status}`;
	}

	async request(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<TransportResult> {
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const headers: Record<string, string> = {
			accept: "application/json",
			"X-API-Key": this.options.apiKey,
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		try {
			const response = await this.options.fetch(
				`${this.options.baseUrl}${path}`,
				{
					method,
					headers,
					body: body === undefined ? null : JSON.stringify(body),
					redirect: "manual",
					signal: combined,
				},
			);
			if (response.status >= 300 && response.status < 400)
				throw new OpenVikingRequestError(
					"openviking redirect refused",
					"redirect",
					response.status,
				);
			if (response.status >= 400) {
				let parsed: unknown = null;
				try {
					parsed = await this.readBody(response);
				} catch {
					void response.body?.cancel().catch(() => undefined);
				}
				throw new OpenVikingRequestError(
					this.errorMessage(parsed, response.status),
					"status",
					response.status,
				);
			}
			return { status: response.status, body: await this.readBody(response) };
		} catch (error) {
			if (error instanceof OpenVikingRequestError) throw error;
			if (timeout.aborted)
				throw new OpenVikingRequestError(
					"openviking request timed out",
					"timeout",
				);
			throw new OpenVikingRequestError(
				error instanceof Error ? error.message : "openviking request failed",
				signal?.aborted ? "timeout" : "network",
			);
		}
	}

	unwrap(result: TransportResult): unknown {
		const body = result.body;
		if (typeof body !== "object" || body === null || Array.isArray(body))
			throw new OpenVikingRequestError(
				"openviking response is not an object",
				"body",
			);
		const object = body as Record<string, unknown>;
		if (object["status"] === "error")
			throw new OpenVikingRequestError(
				this.errorMessage(body, result.status),
				"status",
				result.status,
			);
		if (object["status"] !== "ok")
			throw new OpenVikingRequestError(
				"openviking response status is not ok",
				"body",
			);
		if (!("result" in object) || object["result"] === undefined)
			throw new OpenVikingRequestError(
				"openviking response has no result",
				"body",
			);
		return object["result"];
	}
}
