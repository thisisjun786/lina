/**
 * One Discord HTTP request under policy. This file IS the retry / rate-limit /
 * timeout layer, so the "never call bare fetch in production" rule is waived
 * here on purpose - per-route pre-wait, 429 with a global pause, network/5xx
 * backoff that replays the identical body (same nonce), a per-attempt abort
 * budget, typed fatal errors and token redaction all live here.
 */
import { z } from "zod";
import {
	DiscordRequestError,
	type DiscordRestError,
	DiscordUnavailableError,
	FATAL_BY_STATUS,
} from "./rest-errors.ts";

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const MAX_RATE_LIMIT_RETRIES = 5;
const RATE_LIMIT_FALLBACK_MS = 10_000;
const DETAIL_LIMIT = 200;
/** Abort budget per attempt, fired through the injected scheduler. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The subset of `fetch` this client uses; the global `fetch` satisfies it. */
export type RestFetch = (url: string, init: RequestInit) => Promise<Response>;

export type RestScheduler = {
	/** Runs `handler` after `ms`; the returned function cancels the timer. */
	readonly delay: (ms: number, handler: () => void) => () => void;
};

export type DiscordRestOptions = {
	readonly token: string;
	readonly userAgent: string;
	readonly fetch: RestFetch;
	readonly scheduler: RestScheduler;
	readonly clock: { readonly now: () => number };
	readonly baseUrl?: string;
};

export type RequestSpec = {
	readonly method: "GET" | "POST" | "PUT" | "DELETE";
	/** Rate-limit bucket key: method + path template. */
	readonly route: string;
	readonly path: string;
	readonly body?: unknown;
};

type Attempt =
	| { readonly kind: "ok"; readonly body: string }
	| { readonly kind: "fatal"; readonly error: DiscordRestError }
	| { readonly kind: "limited"; readonly ms: number; readonly global: boolean }
	| { readonly kind: "retryable"; readonly detail: string };

const RateLimitBodySchema = z
	.object({
		retry_after: z.number().optional(),
		global: z.boolean().optional(),
	})
	.catch({});

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) {
			return undefined;
		}
		throw error;
	}
}

function assertNever(value: never): never {
	throw new Error(`unreachable attempt outcome: ${JSON.stringify(value)}`);
}

export function createRestTransport(options: DiscordRestOptions) {
	const base = (options.baseUrl ?? "https://discord.com/api/v10").replace(
		/\/+$/,
		"",
	);
	const routeResetAt = new Map<string, number>();
	let globalPauseUntil = 0;

	/**
	 * Error text quotes Discord bodies; the token never survives redaction.
	 * Redaction runs before the clip so a token straddling DETAIL_LIMIT cannot
	 * leave its prefix behind.
	 */
	const detail = (text: string): string => {
		const redacted =
			options.token === ""
				? text
				: text.split(options.token).join("<redacted>");
		return redacted.slice(0, DETAIL_LIMIT);
	};
	const sleep = (ms: number): Promise<void> =>
		new Promise((resolve) => {
			options.scheduler.delay(ms, resolve);
		});

	/** Pauses are stored as deadlines, so they expire by clock, not by use. */
	const waitForLimits = async (route: string): Promise<void> => {
		const until = Math.max(globalPauseUntil, routeResetAt.get(route) ?? 0);
		const waitMs = until - options.clock.now();
		if (waitMs > 0) {
			await sleep(waitMs);
		}
	};
	/** Pre-wait on the next call once this route's bucket is nearly empty. */
	const noteRateLimit = (route: string, headers: Headers): void => {
		const remaining = headers.get("x-ratelimit-remaining");
		if (remaining === null || Number(remaining) > 1) {
			return;
		}
		const reset = headers.get("x-ratelimit-reset-after");
		const resetAfter = reset === null ? Number.NaN : Number(reset);
		const resetMs = Number.isFinite(resetAfter)
			? resetAfter * 1000
			: RATE_LIMIT_FALLBACK_MS;
		routeResetAt.set(route, options.clock.now() + resetMs);
	};
	const limited = (res: Response, body: string): Attempt => {
		const data = RateLimitBodySchema.parse(parseJson(body));
		const header = res.headers.get("retry-after");
		const seconds = header === null ? data.retry_after : Number(header);
		const ms = Number.isFinite(seconds) ? Number(seconds) * 1000 : 1000;
		return {
			kind: "limited",
			ms: Math.max(0, ms),
			global:
				res.headers.get("x-ratelimit-global") === "true" ||
				data.global === true,
		};
	};
	const classify = (
		spec: RequestSpec,
		res: Response,
		body: string,
	): Attempt => {
		const why = `discord ${spec.route} failed ${res.status}: ${detail(body)}`;
		if (res.status === 429) {
			return limited(res, body);
		}
		if (res.status >= 500) {
			return { kind: "retryable", detail: why };
		}
		const Fatal = FATAL_BY_STATUS[res.status] ?? DiscordRequestError;
		return { kind: "fatal", error: new Fatal(spec.route, why) };
	};

	const attempt = async (spec: RequestSpec): Promise<Attempt> => {
		const controller = new AbortController();
		const cancel = options.scheduler.delay(REQUEST_TIMEOUT_MS, () => {
			controller.abort();
		});
		try {
			const res = await options.fetch(`${base}${spec.path}`, {
				method: spec.method,
				headers: {
					Authorization: `Bot ${options.token}`,
					"User-Agent": options.userAgent,
					"Content-Type": "application/json",
				},
				...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
				signal: controller.signal,
			});
			const body = await res.text();
			noteRateLimit(spec.route, res.headers);
			return res.ok ? { kind: "ok", body } : classify(spec, res, body);
		} catch (error) {
			// Transport failure (reset, DNS, abort): retryable by policy, not fatal.
			const why = error instanceof Error ? error.message : String(error);
			return { kind: "retryable", detail: detail(why) };
		} finally {
			cancel();
		}
	};

	const send = async (spec: RequestSpec): Promise<string> => {
		let limitRetries = 0;
		let networkRetries = 0;
		for (;;) {
			await waitForLimits(spec.route);
			const outcome = await attempt(spec);
			switch (outcome.kind) {
				case "ok":
					return outcome.body;
				case "fatal":
					throw outcome.error;
				case "limited": {
					if (limitRetries >= MAX_RATE_LIMIT_RETRIES) {
						throw new DiscordUnavailableError(
							spec.route,
							`discord ${spec.route} rate limited on every attempt`,
						);
					}
					limitRetries += 1;
					const until = options.clock.now() + outcome.ms;
					if (outcome.global) {
						globalPauseUntil = Math.max(globalPauseUntil, until);
					} else {
						routeResetAt.set(spec.route, until);
					}
					break;
				}
				case "retryable": {
					const backoffMs = BACKOFF_MS[networkRetries];
					if (backoffMs === undefined) {
						throw new DiscordUnavailableError(
							spec.route,
							`discord ${spec.route} gave up after ${networkRetries + 1} attempts: ${outcome.detail}`,
						);
					}
					networkRetries += 1;
					await sleep(backoffMs);
					break;
				}
				default:
					assertNever(outcome);
			}
		}
	};

	return {
		send,
		sendJson: async <T>(
			spec: RequestSpec,
			schema: z.ZodType<T>,
		): Promise<T> => {
			const body = await send(spec);
			const result = schema.safeParse(parseJson(body));
			if (!result.success) {
				throw new DiscordRequestError(
					spec.route,
					`discord ${spec.route} returned an unusable body: ${detail(body)}`,
				);
			}
			return result.data;
		},
	};
}
