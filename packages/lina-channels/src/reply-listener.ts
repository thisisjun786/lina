import type { SessionRegistry } from "./session-registry.ts";
import type { Channel, InboundMessage, SessionId } from "./types.ts";

export interface ChannelAdapter {
	readonly channel: Channel;
	poll(since: string | undefined): Promise<readonly InboundMessage[]>;
}

export interface SessionInjector {
	inject(sessionId: SessionId, text: string): Promise<void>;
}

export type ReplyListenerOptions = {
	readonly adapters: readonly ChannelAdapter[];
	readonly registry: SessionRegistry;
	readonly injector: SessionInjector;
	readonly pollIntervalMs: number;
	readonly rateLimitPerMinute: number;
	readonly now?: () => number;
};

const MINUTE_MS = 60_000;

export function startReplyListener(options: ReplyListenerOptions): {
	stop: () => void;
	tick: () => Promise<void>;
} {
	const clock = options.now ?? Date.now;
	const lastSince = new Map<ChannelAdapter, string>();
	const injectTimes: number[] = [];
	let timer: ReturnType<typeof setInterval> | undefined;

	const tick = async (): Promise<void> => {
		for (const adapter of options.adapters) {
			const messages = await adapter.poll(lastSince.get(adapter));
			lastSince.set(adapter, new Date(clock()).toISOString());
			for (const message of messages) {
				await deliver(message, options, clock, injectTimes);
			}
		}
	};

	if (options.pollIntervalMs > 0) {
		timer = setInterval(() => {
			void tick();
		}, options.pollIntervalMs);
	}

	return {
		stop: (): void => {
			if (timer === undefined) {
				return;
			}
			clearInterval(timer);
			timer = undefined;
		},
		tick,
	};
}

async function deliver(
	message: InboundMessage,
	options: ReplyListenerOptions,
	clock: () => number,
	injectTimes: number[],
): Promise<void> {
	const lookupId = message.replyTo ?? message.messageId;
	const entry = await options.registry.lookupByMessage(lookupId);
	if (entry === undefined) {
		return;
	}
	if (!allowInject(clock(), options.rateLimitPerMinute, injectTimes)) {
		return;
	}
	await options.injector.inject(entry.sessionId, message.text);
}

function allowInject(
	at: number,
	rateLimitPerMinute: number,
	injectTimes: number[],
): boolean {
	const cutoff = at - MINUTE_MS;
	const inWindow = injectTimes.filter((stamp) => stamp > cutoff);
	injectTimes.length = 0;
	injectTimes.push(...inWindow);
	if (injectTimes.length >= rateLimitPerMinute) {
		return false;
	}
	injectTimes.push(at);
	return true;
}
