import type { DiscordAdapter } from "../adapters/discord.ts";
import type { DiscordMessage } from "./schemas.ts";

export type CatchupScheduler = {
	readonly interval: (
		ms: number,
		handler: () => void | Promise<void>,
	) => () => void;
};

export type CatchupSourceOptions = {
	readonly adapter: DiscordAdapter;
	readonly intervalMs: number;
	readonly scheduler: CatchupScheduler;
	readonly onMessages: (messages: readonly DiscordMessage[]) => void;
	readonly onError: (error: unknown) => void;
};

export type CatchupSource = {
	readonly runOnce: () => Promise<void>;
	readonly start: () => void;
	readonly stop: () => void;
	readonly pause: () => void;
	readonly resume: () => void;
};

export function createCatchupSource(
	options: CatchupSourceOptions,
): CatchupSource {
	let paused = false;
	let cancel: (() => void) | undefined;

	const runOnce = async (): Promise<void> => {
		if (paused) {
			return;
		}
		const messages = await options.adapter.pollRaw();
		options.onMessages(messages);
	};

	return {
		runOnce,
		start: (): void => {
			if (cancel !== undefined) {
				return;
			}
			cancel = options.scheduler.interval(options.intervalMs, () =>
				runOnce().catch((error: unknown) => {
					options.onError(error);
				}),
			);
		},
		stop: (): void => {
			cancel?.();
			cancel = undefined;
		},
		pause: (): void => {
			paused = true;
		},
		resume: (): void => {
			paused = false;
		},
	};
}
