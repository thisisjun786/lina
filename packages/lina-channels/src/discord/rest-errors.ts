/** The typed Discord REST failure taxonomy: fatal ones stop the bridge. */

export class DiscordRestError extends Error {
	constructor(
		readonly route: string,
		message: string,
	) {
		super(message);
	}
}

/** Fatal (401): the bot token was rejected. Never retried. */
export class DiscordAuthError extends DiscordRestError {
	readonly name = "DiscordAuthError";
}

/** Fatal (403): the bot lacks a permission or intent. Never retried. */
export class DiscordPermissionError extends DiscordRestError {
	readonly name = "DiscordPermissionError";
}

/** Fatal (404): the channel or message does not exist. Never retried. */
export class DiscordNotFoundError extends DiscordRestError {
	readonly name = "DiscordNotFoundError";
}

/** The request is wrong, or a 2xx carried a body this client cannot use. */
export class DiscordRequestError extends DiscordRestError {
	readonly name = "DiscordRequestError";
}

/** Retries exhausted: network failures, 5xx, or repeated rate limiting. */
export class DiscordUnavailableError extends DiscordRestError {
	readonly name = "DiscordUnavailableError";
}

type FatalCtor = new (route: string, message: string) => DiscordRestError;

/** Statuses that must never be retried, mapped to the error callers match on. */
export const FATAL_BY_STATUS: Record<number, FatalCtor> = {
	401: DiscordAuthError,
	403: DiscordPermissionError,
	404: DiscordNotFoundError,
};
