import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parse } from "./client-contract.ts";
import { type Ima2ClientOptions, Ima2Error } from "./client-types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 64 * 1024;
const discoverySchema = z.object({ backend: z.object({ url: z.string() }) });

function origin(value: string): string {
	try {
		if (!/^https?:\/\//i.test(value) || /[\s\\?#@]/.test(value))
			throw new Error();
		const url = new URL(value);
		if (url.pathname !== "/" || url.username || url.password) throw new Error();
		return url.origin;
	} catch {
		throw new Ima2Error(
			"INVALID_SERVER_URL",
			"ima2 server must be an HTTP(S) origin without credentials or path",
		);
	}
}

async function discover(serverFile: string): Promise<string> {
	try {
		const file = await open(serverFile, "r");
		let value: unknown;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size > MAX_DISCOVERY_BYTES) throw new Error();
			const buffer = Buffer.alloc(MAX_DISCOVERY_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_DISCOVERY_BYTES) throw new Error();
			value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		} finally {
			await file.close();
		}
		const base = origin(parse(discoverySchema, value).backend.url);
		if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
			throw new Error();
		return base;
	} catch {
		throw new Ima2Error(
			"DISCOVERY_UNAVAILABLE",
			"No usable local ima2 server discovery; configure a server origin or start ima2 separately",
		);
	}
}

function aborted(signal: AbortSignal): Ima2Error {
	return new Ima2Error(
		signal.reason instanceof Ima2Error && signal.reason.code === "TIMEOUT"
			? "TIMEOUT"
			: "ABORTED",
		"ima2 request stopped before a response was confirmed",
	);
}

async function untilAbort<T>(
	work: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	let onAbort = () => {};
	const stop = new Promise<never>((_, reject) => {
		onAbort = () => reject(aborted(signal));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([work, stop]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function boundedBody(
	response: Response,
	limit: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit))
		throw new Ima2Error(
			"BODY_TOO_LARGE",
			"ima2 response exceeds the byte limit",
		);
	if (!response.body)
		throw new Ima2Error("INVALID_RESPONSE", "ima2 response body is missing");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await untilAbort(reader.read(), signal);
			if (done) break;
			total += value.byteLength;
			if (total > limit)
				throw new Ima2Error(
					"BODY_TOO_LARGE",
					"ima2 response exceeds the byte limit",
				);
			chunks.push(value);
		}
	} finally {
		void reader.cancel().catch(() => {}); // Cleanup cannot replace the safe boundary error.
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function httpError(status: number): Ima2Error {
	// A 409 may refer to an existing paid generation, not a rejected job.
	const outcome = status < 500 && status !== 409 ? "rejected" : "unknown";
	if (status === 401 || status === 403)
		return new Ima2Error(
			"ACCESS_DENIED",
			"ima2 access denied; configure access in ima2",
			outcome,
			status,
		);
	if (status === 409)
		return new Ima2Error(
			"CONFLICT",
			"ima2 request identity is already in use or conflicts with a prior request",
			outcome,
			status,
		);
	if (status === 429)
		return new Ima2Error(
			"RATE_LIMITED",
			"ima2 rejected the request due to a rate or capacity limit",
			outcome,
			status,
		);
	return new Ima2Error(
		"HTTP_ERROR",
		"ima2 returned an unsuccessful HTTP response",
		outcome,
		status,
	);
}

/** Callback errors/results are untrusted diagnostics, never serialized or echoed. */
function authorizeSubmit(
	beforeSubmit: (url: string) => undefined,
	url: string,
) {
	try {
		const result: unknown = beforeSubmit(url);
		if (result !== undefined) {
			// An untyped async callback is forbidden; consume its rejection without
			// yielding or allowing POST. Its side effects remain the caller's error.
			void Promise.resolve(result).catch(() => {});
			throw new Error();
		}
	} catch {
		throw new Ima2Error(
			"SUBMIT_DENIED",
			"ima2 submission authority denied POST",
			"rejected",
			undefined,
			"not-dispatched",
		);
	}
}

export class Ima2Http {
	readonly #options: Ima2ClientOptions;
	readonly #timeoutMs: number;
	#origin: Promise<string> | undefined;

	constructor(options: Ima2ClientOptions) {
		this.#options = { ...options };
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
			throw new Ima2Error(
				"INVALID_INPUT",
				"ima2 timeout must be a positive integer",
			);
	}

	async baseUrl(signal?: AbortSignal): Promise<string> {
		if (signal?.aborted) throw aborted(signal);
		if (!this.#origin) {
			const selected = this.#options.baseUrl;
			const pending =
				selected === undefined
					? discover(
							this.#options.serverFile ??
								join(homedir(), ".ima2", "server.json"),
						)
					: Promise.resolve().then(() => origin(selected));
			this.#origin = pending;
			void pending.catch(() => {
				if (this.#origin === pending) this.#origin = undefined;
			});
		}
		return signal ? untilAbort(this.#origin, signal) : this.#origin;
	}

	async json(
		path: string,
		init: RequestInit = {},
		beforeSubmit?: (url: string) => undefined,
	): Promise<{ status: number; value: unknown }> {
		const response = await this.request(
			path,
			init,
			MAX_JSON_BYTES,
			true,
			beforeSubmit,
		);
		try {
			return {
				status: response.status,
				value: JSON.parse(
					new TextDecoder("utf-8", { fatal: true }).decode(response.bytes),
				) as unknown,
			};
		} catch {
			throw new Ima2Error(
				"INVALID_RESPONSE",
				"ima2 returned malformed JSON",
				init.method === "POST" || init.method === "DELETE"
					? "unknown"
					: "rejected",
				undefined,
				path === "/api/generate" && init.method === "POST"
					? "dispatched"
					: "unknown",
			);
		}
	}

	async request(
		path: string,
		init: RequestInit,
		limit: number,
		json = false,
		beforeSubmit?: (url: string) => undefined,
	): Promise<{ bytes: Uint8Array; mime: string; status: number }> {
		const controller = new AbortController();
		const parent = init.signal;
		const onAbort = () => controller.abort();
		if (parent?.aborted) throw aborted(parent);
		parent?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() =>
				controller.abort(new Ima2Error("TIMEOUT", "ima2 request timed out")),
			this.#timeoutMs,
		);
		let sent = false;
		let response: Response | undefined;
		try {
			const base = await this.baseUrl(controller.signal);
			const target = new URL(path, base);
			if (!path.startsWith("/") || target.origin !== base)
				throw new Ima2Error(
					"INVALID_SERVER_URL",
					"ima2 request must stay on the selected origin",
				);
			const request = {
				...init,
				signal: controller.signal,
				redirect: "manual" as const,
				credentials: "omit" as const,
			};
			const send = this.#options.fetch ?? fetch;
			if (controller.signal.aborted) throw aborted(controller.signal);
			if (beforeSubmit) authorizeSubmit(beforeSubmit, target.href);
			// Synchronous abort inside the guard also prevents dispatch. There is
			// no await or mutable caller material between this check and fetch.
			if (controller.signal.aborted) throw aborted(controller.signal);
			sent = true;
			response = await untilAbort(
				send(target.href, request),
				controller.signal,
			);
			if (
				response.redirected ||
				(response.status >= 300 && response.status < 400)
			)
				throw new Ima2Error(
					"REDIRECT_REFUSED",
					"ima2 redirects are not allowed",
				);
			if (!response.ok) throw httpError(response.status);
			const mime =
				response.headers
					.get("content-type")
					?.split(";")[0]
					?.trim()
					.toLowerCase() ?? "";
			if (json && mime !== "application/json")
				throw new Ima2Error("INVALID_RESPONSE", "ima2 response was not JSON");
			return {
				bytes: await boundedBody(response, limit, controller.signal),
				mime,
				status: response.status,
			};
		} catch (error) {
			const safe = controller.signal.aborted
				? aborted(controller.signal)
				: error instanceof Ima2Error
					? error
					: new Ima2Error("NETWORK_ERROR", "ima2 transport failed");
			const mutation = init.method === "POST" || init.method === "DELETE";
			const definiteRejection =
				safe.status !== undefined &&
				safe.status >= 400 &&
				safe.status < 500 &&
				safe.status !== 409;
			throw new Ima2Error(
				safe.code,
				safe.message,
				mutation && sent && !definiteRejection ? "unknown" : safe.outcome,
				safe.status,
				path === "/api/generate" && init.method === "POST"
					? sent
						? "dispatched"
						: "not-dispatched"
					: "unknown",
			);
		} finally {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
			if (response?.body && !response.body.locked)
				void response.body.cancel().catch(() => {});
		}
	}
}
