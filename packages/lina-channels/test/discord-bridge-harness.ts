import type { AgentRunState } from "../src/bridge/frames.ts";
import type { ConnectionState } from "../src/bridge/intervention-client.ts";
import { createTurnCollector } from "../src/bridge/turn-collector.ts";
import { createInboundQueue } from "../src/discord/inbound-queue.ts";
import type { DiscordMessage } from "../src/discord/schemas.ts";
import {
	type BridgeDependencies,
	type BridgeRuntime,
	runBridge,
} from "../src/discord-bridge.ts";
import { config } from "./discord-bridge-fixtures.ts";

type Listener<T> = (value: T) => void;
type HarnessOptions = {
	readonly authError?: Error;
	readonly startError?: Error;
	readonly stopError?: Error;
	readonly realPipeline?: boolean;
	readonly senderMessageIds?: readonly string[];
};

export function harness(options: HarnessOptions = {}) {
	const calls: string[] = [];
	const logs: string[] = [];
	const seen = new Set<string>();
	const record = (name: string) => (): void => {
		calls.push(name);
	};
	let connection: Listener<ConnectionState> = () => {};
	let status: Listener<AgentRunState> = () => {};
	let text: Listener<string> = () => {};
	let gatewayMessages: Listener<readonly DiscordMessage[]> = () => {};
	let ready = (): void => {};
	let resume = (): void => {};
	let disconnect = (): void => {};
	let catchupMessages: Listener<readonly DiscordMessage[]> = () => {};
	let turn: Listener<string> = () => {};
	let catchupBatch: readonly DiscordMessage[] = [];
	let offerError: Error | undefined;
	let drainError: Error | undefined;
	let senderError: Error | undefined;
	let catchupWait: Promise<void> | undefined;
	let senderWait: Promise<void> | undefined;
	let lastAcked: string | undefined;
	let catchupPaused = false;
	const catchupStarted = Promise.withResolvers<void>();
	let cursorValue:
		| {
				readonly version: 1;
				readonly channelId: string;
				readonly lastSeenMessageId: string;
		  }
		| undefined;
	const cursor = {
		path: "memory",
		channelId: "555",
		read: () => Promise.resolve(cursorValue),
		write: async (value: typeof cursorValue) => {
			cursorValue = value;
			calls.push("cursor.write");
		},
		advance: async (id: string) => {
			cursorValue = {
				version: 1,
				channelId: "555",
				lastSeenMessageId: id,
			};
			return true;
		},
	};
	const deps: BridgeDependencies = {
		rest: {
			getMe: () =>
				options.authError === undefined
					? Promise.resolve({ id: "99" })
					: Promise.reject(options.authError),
			getLatestMessage: () => Promise.resolve(undefined),
		},
		cursor,
		interventionClient: {
			connect: record("intervention.connect"),
			close: record("intervention.close"),
			send: async (frame) => {
				calls.push(`inject:${frame.id}`);
				lastAcked = frame.id;
				return { id: frame.id };
			},
			onStatus: (listener) => {
				status = listener;
			},
			onText: (listener) => {
				text = listener;
			},
			onConnectionChange: (listener) => {
				connection = listener;
			},
			state: () => "disconnected",
		},
		gatewaySource: {
			start: async () => {
				calls.push("gateway.start");
				if (options.startError !== undefined) throw options.startError;
			},
			stop: async () => {
				calls.push("gateway.stop");
				if (options.stopError !== undefined) throw options.stopError;
			},
			state: () => "running",
			onMessages: (listener) => {
				gatewayMessages = listener;
			},
			onReady: (listener) => {
				ready = () => listener({ botUserId: "99" });
			},
			onDisconnect: (listener) => {
				disconnect = listener;
			},
			onResume: (listener) => {
				resume = listener;
			},
		},
		catchupSource: (handlers) => {
			catchupMessages = handlers.onMessages;
			return {
				runOnce: async () => {
					calls.push("catchup.run");
					catchupStarted.resolve();
					await catchupWait;
					if (!catchupPaused) catchupMessages(catchupBatch);
				},
				start: record("catchup.start"),
				stop: record("catchup.stop"),
				pause: () => {
					catchupPaused = true;
					calls.push("catchup.pause");
				},
				resume: () => {
					catchupPaused = false;
					calls.push("catchup.resume");
				},
			};
		},
		queue: (botUserId) =>
			options.realPipeline
				? createInboundQueue({
						botUserId,
						allowedUserIds: ["42"],
						cursor,
						inject: deps.interventionClient.send,
						react: {
							accept: async (id) => {
								calls.push(`react:${id}`);
							},
						},
						log: (line) => {
							logs.push(line);
						},
					})
				: {
						offer: async (messages, source) => {
							calls.push(
								`offer:${source}:${messages.map(({ id }) => id).join(",")}`,
							);
							if (offerError !== undefined) throw offerError;
							for (const item of messages) {
								if (!seen.has(item.id)) calls.push(`admitted:${item.id}`);
								seen.add(item.id);
							}
						},
						drain: async () => {
							calls.push("drain");
							if (drainError !== undefined) throw drainError;
						},
						pause: record("queue.pause"),
						resume: record("queue.resume"),
						head: () => undefined,
						size: () => seen.size,
						lastAckedMessageId: () => lastAcked,
					},
		collector: (onTurn) => {
			turn = onTurn;
			return options.realPipeline
				? createTurnCollector(onTurn)
				: {
						accept: (frame) => {
							calls.push(`collector:${frame.type}`);
						},
						close: record("collector.close"),
						state: () => "idle",
					};
		},
		sender: {
			sendReply: async ({ replyToMessageId, text }) => {
				await senderWait;
				if (senderError !== undefined) throw senderError;
				calls.push(`send:${replyToMessageId}:${text}`);
				return { messageIds: options.senderMessageIds ?? ["800"] };
			},
		},
		log: (line) => {
			logs.push(line);
		},
	};
	return {
		calls,
		logs,
		deps,
		setCatchup: (items: readonly DiscordMessage[]) => {
			catchupBatch = items;
		},
		setOfferError: (error: Error | undefined) => {
			offerError = error;
		},
		setDrainError: (error: Error | undefined) => {
			drainError = error;
		},
		setSenderError: (error: Error | undefined) => {
			senderError = error;
		},
		setCatchupWait: (wait: Promise<void>) => {
			catchupWait = wait;
		},
		setSenderWait: (wait: Promise<void>) => {
			senderWait = wait;
		},
		catchupStarted: catchupStarted.promise,
		emitConnected: () => connection("connected"),
		emitDisconnected: () => connection("disconnected"),
		emitGateway: (items: readonly DiscordMessage[]) => gatewayMessages(items),
		emitReady: () => ready(),
		emitResume: () => resume(),
		emitGatewayDisconnect: () => disconnect(),
		emitStatus: (value: AgentRunState) => status(value),
		emitText: (value: string) => text(value),
		emitTurn: (value: string) => turn(value),
	};
}

export async function started(
	h = harness(),
): Promise<typeof h & { readonly runtime: BridgeRuntime }> {
	return { ...h, runtime: await runBridge(config, h.deps) };
}
