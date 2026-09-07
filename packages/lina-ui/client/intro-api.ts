import {
	INTRO_MANAGE_TIMEOUT_MS,
	INTRO_MODEL_TIMEOUT_MS,
} from "./intro-types.ts";
import { isOnboardingAbort, OnboardingHttpError } from "./onboarding-api.ts";
import { parseOnboardingError } from "./onboarding-model.ts";

export type IntroRequestFn = (
	path: string,
	method?: string,
	body?: unknown,
	signal?: AbortSignal,
) => Promise<unknown>;

export { isOnboardingAbort, OnboardingHttpError };

function timeoutFor(path: string, method: string): number {
	if (method === "GET") return INTRO_MANAGE_TIMEOUT_MS;
	if (
		/\/intro\/(?:turn|finish|choose|restart)$/.test(path) ||
		path === "/api/agents/birth"
	)
		return INTRO_MODEL_TIMEOUT_MS;
	return INTRO_MANAGE_TIMEOUT_MS;
}

export async function introRequest(
	path: string,
	method = "GET",
	body?: unknown,
	signal?: AbortSignal,
): Promise<unknown> {
	const timeout = AbortSignal.timeout(timeoutFor(path, method));
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
		if (isOnboardingAbort(error)) throw error;
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
