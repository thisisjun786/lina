import WebSocket from "ws";
import { DiscordAdapter } from "../adapters/discord.ts";
import {
	type CatchupSource,
	type CatchupSourceOptions,
	createCatchupSource,
} from "../discord/catchup-source.ts";
import { CursorStore, type DiscordCursor } from "../discord/cursor-store.ts";
import {
	createGatewaySource,
	type GatewaySource,
} from "../discord/gateway-source.ts";
import {
	createInboundQueue,
	type InboundQueue,
} from "../discord/inbound-queue.ts";
import { createDiscordRest } from "../discord/rest.ts";
import type { BridgeConfig, DiscordMessage } from "../discord/schemas.ts";
import { createDiscordSender } from "../discord/sender.ts";
import {
	createInterventionClient,
	type InterventionClient,
} from "./intervention-client.ts";
import { createTurnCollector, type TurnCollector } from "./turn-collector.ts";

export type BridgeDependencies = {
	readonly rest: {
		readonly getMe: () => Promise<{ readonly id: string }>;
		readonly getLatestMessage: (
			channelId: string,
		) => Promise<DiscordMessage | undefined>;
	};
	readonly cursor: {
		readonly channelId: string;
		readonly read: () => Promise<DiscordCursor | undefined>;
		readonly write: (cursor: DiscordCursor) => Promise<void>;
	};
	readonly interventionClient: InterventionClient;
	readonly gatewaySource: GatewaySource;
	readonly catchupSource: (
		handlers: Pick<CatchupSourceOptions, "onMessages" | "onError">,
	) => CatchupSource;
	readonly queue: (botUserId: string) => InboundQueue;
	readonly collector: (onTurn: (text: string) => void) => TurnCollector;
	readonly sender: ReturnType<typeof createDiscordSender>;
	readonly log: (line: string) => void;
};

export type MainOptions = {
	readonly env: Record<string, string | undefined>;
	readonly dependencies: (config: BridgeConfig) => BridgeDependencies;
	readonly exit: (code: number) => void;
	readonly stderr: (value: unknown) => void;
};

export type BridgeRuntime = {
	readonly settled: () => Promise<void>;
	readonly stop: () => Promise<void>;
};

export type BridgeLifecycleResources = {
	readonly queue: Pick<InboundQueue, "pause">;
	readonly catchup: Pick<CatchupSource, "pause" | "stop">;
	readonly intervention: Pick<InterventionClient, "close">;
	readonly collector: Pick<TurnCollector, "close">;
	readonly gateway: Pick<GatewaySource, "stop">;
	readonly onCleanupError: (error: unknown) => void;
};

export function createBridgeLifecycle(resources: BridgeLifecycleResources) {
	let stopped = false;
	let cleanup: Promise<void> | undefined;
	const safely = (operation: () => void): void => {
		try {
			operation();
		} catch (error) {
			resources.onCleanupError(error);
		}
	};
	return {
		stopped: (): boolean => stopped,
		stop(): Promise<void> {
			if (cleanup !== undefined) return cleanup;
			stopped = true;
			safely(resources.queue.pause);
			safely(resources.catchup.pause);
			safely(resources.catchup.stop);
			safely(resources.intervention.close);
			safely(resources.collector.close);
			cleanup = Promise.resolve()
				.then(resources.gateway.stop)
				.catch(resources.onCleanupError);
			return cleanup;
		},
	};
}

export class BridgeFatalError extends Error {
	override readonly name = "BridgeFatalError";
}

export function describeBridgeError(error: unknown, token: string): string {
	const detail = error instanceof Error ? error.message : String(error);
	return detail.split(token).join("<redacted>");
}

const scheduler = {
	delay: (ms: number, handler: () => void) => {
		const timer = setTimeout(handler, ms);
		return () => clearTimeout(timer);
	},
};

export function createRealBridgeDependencies(
	config: BridgeConfig,
): BridgeDependencies {
	const log = (...parts: readonly unknown[]): void => {
		const line = parts
			.map((part) => (part instanceof Error ? part.message : String(part)))
			.join(" ")
			.split(config.token)
			.join("<redacted>");
		console.error(line);
	};
	const rest = createDiscordRest({
		token: config.token,
		userAgent: config.userAgent,
		fetch,
		scheduler,
		clock: { now: Date.now },
		baseUrl: config.restApi,
	});
	const cursor = new CursorStore(config.cursorPath, config.channelId);
	const adapter = new DiscordAdapter({
		rest,
		channelId: config.channelId,
		cursor,
	});
	const interventionClient = createInterventionClient({
		url: config.interventionUrl,
		wsFactory: (url) => new WebSocket(url),
		log,
	});
	return {
		rest,
		cursor,
		interventionClient,
		gatewaySource: createGatewaySource({
			token: config.token,
			channelId: config.channelId,
			gateway: config.gateway,
			restApiBase: config.restApi,
			log,
		}),
		catchupSource: (handlers) => {
			let raw: CatchupSource;
			let runs = Promise.resolve();
			const runOnce = (): Promise<void> => {
				const next = runs.then(() => raw.runOnce());
				runs = next.catch(() => undefined);
				return next;
			};
			raw = createCatchupSource({
				adapter,
				intervalMs: config.catchupMs,
				scheduler: {
					interval: (ms) => {
						const timer = setInterval(() => {
							void runOnce().catch(handlers.onError);
						}, ms);
						return () => clearInterval(timer);
					},
				},
				...handlers,
			});
			return { ...raw, runOnce };
		},
		queue: (botUserId) =>
			createInboundQueue({
				botUserId,
				allowedUserIds: config.allowedUserIds,
				cursor,
				inject: (frame) => interventionClient.send(frame),
				react: {
					accept: (messageId) =>
						rest.addReaction(config.channelId, messageId, "👀"),
				},
				log,
			}),
		collector: (onTurn) => createTurnCollector(onTurn),
		sender: createDiscordSender({ rest, channelId: config.channelId, log }),
		log,
	};
}
