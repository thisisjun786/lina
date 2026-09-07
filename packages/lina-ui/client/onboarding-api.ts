import { parseOnboardingError } from "./onboarding-model.ts";
import { MANAGE_TIMEOUT_MS, MODEL_TIMEOUT_MS } from "./onboarding-types.ts";

export type OnboardingRequestFn = (
	path: string,
	method?: string,
	body?: unknown,
	signal?: AbortSignal,
) => Promise<unknown>;

export class OnboardingHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body: unknown,
	) {
		super(message);
		this.name = "OnboardingHttpError";
	}
}

function isAbort(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "AbortError" || error.message.startsWith("aborted"))
	);
}

export function isOnboardingAbort(error: unknown): boolean {
	return isAbort(error);
}

function timeoutFor(path: string): number {
	return /\/(?:interview|preview)$/.test(path)
		? MODEL_TIMEOUT_MS
		: MANAGE_TIMEOUT_MS;
}

export async function onboardingRequest(
	path: string,
	method = "GET",
	body?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(timeoutFor(path));
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetch(path, {
			method,
			headers: body ? { "Content-Type": "application/json" } : {},
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: combined,
			redirect: "error",
			credentials: "same-origin",
		});
	} catch (error) {
		if (isAbort(error)) throw error;
		if (error instanceof Error && error.name === "TimeoutError")
			throw new OnboardingHttpError(
				504,
				parseOnboardingError(504, null).message,
				null,
			);
		throw new OnboardingHttpError(
			502,
			parseOnboardingError(502, null).message,
			null,
		);
	}
	const value: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const parsed = parseOnboardingError(response.status, value);
		throw new OnboardingHttpError(response.status, parsed.message, value);
	}
	return value;
}
