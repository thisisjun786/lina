import { HonchoRequestError } from "./types.ts";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface TransportOptions {
	baseUrl: string;
	apiKey?: string | undefined;
	fetch: FetchLike;
	timeoutMs: number;
	bodyCapBytes: number;
}

export interface TransportResult {
	status: number;
	body: unknown;
}

// One HTTP request per call. No retry, no redirect following, bounded time and body.
export class HonchoTransport {
	constructor(private readonly options: TransportOptions) {
		if (
			options.timeoutMs < 1 ||
			options.timeoutMs > 2000 ||
			options.bodyCapBytes < 1
		)
			throw new Error("invalid honcho client options");
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
					throw new HonchoRequestError(
						"honcho response body too large",
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
			throw new HonchoRequestError("honcho response is not JSON", "body");
		}
	}

	async request(
		method: "GET" | "POST",
		path: string,
		body: unknown,
		signal: AbortSignal | undefined,
	): Promise<TransportResult> {
		const timeout = AbortSignal.timeout(this.options.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const headers: Record<string, string> = { accept: "application/json" };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (this.options.apiKey)
			headers["authorization"] = `Bearer ${this.options.apiKey}`;
		try {
			const response = await this.options.fetch(
				`${this.options.baseUrl}/v3${path}`,
				{
					method,
					headers,
					body: body === undefined ? null : JSON.stringify(body),
					redirect: "manual",
					signal: combined,
				},
			);
			if (response.status >= 300 && response.status < 400)
				throw new HonchoRequestError(
					"honcho redirect refused",
					"redirect",
					response.status,
				);
			if (response.status >= 400) {
				void response.body?.cancel().catch(() => undefined);
				throw new HonchoRequestError(
					`honcho status ${response.status}`,
					"status",
					response.status,
				);
			}
			return { status: response.status, body: await this.readBody(response) };
		} catch (error) {
			if (error instanceof HonchoRequestError) throw error;
			if (timeout.aborted)
				throw new HonchoRequestError("honcho request timed out", "timeout");
			throw new HonchoRequestError(
				error instanceof Error ? error.message : "honcho request failed",
				signal?.aborted ? "timeout" : "network",
			);
		}
	}

	expect(result: TransportResult, ok: number[]): unknown {
		if (!ok.includes(result.status))
			throw new HonchoRequestError(
				`honcho status ${result.status}`,
				"status",
				result.status,
			);
		return result.body;
	}
}
