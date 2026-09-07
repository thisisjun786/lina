import type { AgentRunState } from "./bridge/frames.ts";
import {
	type BridgeDependencies,
	BridgeFatalError,
	type BridgeRuntime,
	createBridgeLifecycle,
	createRealBridgeDependencies,
	describeBridgeError,
	type MainOptions,
} from "./bridge/wiring.ts";
import type { DiscordCursor } from "./discord/cursor-store.ts";
import { DiscordAuthError } from "./discord/rest.ts";
import {
	type BridgeConfig,
	type DiscordMessage,
	parseBridgeConfig,
} from "./discord/schemas.ts";

const PREFIX = "[discord-bridge]" as const;

export type { BridgeDependencies, BridgeRuntime } from "./bridge/wiring.ts";
export { BridgeFatalError } from "./bridge/wiring.ts";

export async function runBridge(
	config: BridgeConfig,
	deps: BridgeDependencies,
): Promise<BridgeRuntime> {
	let identity: { readonly id: string };
	try {
		identity = await deps.rest.getMe();
	} catch (error) {
		if (error instanceof DiscordAuthError)
			throw new BridgeFatalError("invalid DISCORD_BOT_TOKEN", { cause: error });
		throw error;
	}
	if ((await deps.cursor.read()) === undefined) {
		const latest = await deps.rest.getLatestMessage(config.channelId);
		const initial: DiscordCursor = {
			version: 1,
			channelId: deps.cursor.channelId,
			lastSeenMessageId: latest?.id ?? "0",
		};
		await deps.cursor.write(initial);
	}

	const queue = deps.queue(identity.id);
	let delivery = Promise.resolve();
	let outbound = Promise.resolve();
	let interventionConnected = false;
	let gatewayConnected = config.gateway === "off";
	let activeCatchup: DiscordMessage[][] | undefined;
	const gatewayBacklog: DiscordMessage[][] = [];

	const report = (context: string, error: unknown): void => {
		deps.log(
			`${PREFIX} ${context}: ${describeBridgeError(error, config.token)}`,
		);
	};
	const deliver = async (
		messages: readonly DiscordMessage[],
		source: "gateway" | "catchup",
	): Promise<void> => {
		deps.log(
			`${PREFIX} ${source === "catchup" ? `catch-up: ${messages.length} messages` : `gateway: ${messages.length} messages`}`,
		);
		await queue.offer(messages, source);
		await queue.drain();
		const acked = queue.lastAckedMessageId();
		if (acked !== undefined) deps.log(`${PREFIX} injected ${acked}`);
	};
	const enqueue = (operation: () => Promise<void>): void => {
		if (lifecycle.stopped()) return;
		delivery = delivery
			.then(async () => {
				if (!lifecycle.stopped()) await operation();
			})
			.catch((error: unknown) => {
				if (!lifecycle.stopped()) report("delivery failed", error);
			});
	};
	const collector = deps.collector((text) => {
		if (lifecycle.stopped()) return;
		if (text === "") {
			deps.log("turn-empty");
			return;
		}
		const replyToMessageId = queue.lastAckedMessageId();
		if (replyToMessageId === undefined) return;
		outbound = outbound
			.then(async () => {
				if (lifecycle.stopped()) return;
				const result = await deps.sender.sendReply({ replyToMessageId, text });
				const last = result.messageIds.at(-1);
				if (last !== undefined) deps.log(`${PREFIX} posted reply ${last}`);
			})
			.catch((error: unknown) => {
				report("reply failed", error);
			});
	});
	const catchup = deps.catchupSource({
		onMessages: (messages) => {
			if (lifecycle.stopped()) return;
			if (activeCatchup !== undefined) {
				activeCatchup.push([...messages]);
				return;
			}
			enqueue(() => deliver(messages, "catchup"));
		},
		onError: (error) => {
			if (!lifecycle.stopped()) report("catch-up failed", error);
		},
	});
	const lifecycle = createBridgeLifecycle({
		queue,
		catchup,
		intervention: deps.interventionClient,
		collector,
		gateway: deps.gatewaySource,
		onCleanupError: (error) => report("cleanup failed", error),
	});
	const enqueueCatchup = (): void => {
		enqueue(async () => {
			const batches: DiscordMessage[][] = [];
			activeCatchup = batches;
			try {
				await catchup.runOnce();
			} finally {
				activeCatchup = undefined;
			}
			for (const batch of batches) await deliver(batch, "catchup");
		});
	};
	const pause = (): void => {
		queue.pause();
		catchup.pause();
		collector.close();
	};
	const resume = (): void => {
		queue.resume();
		catchup.resume();
		enqueueCatchup();
		for (const batch of gatewayBacklog.splice(0))
			enqueue(() => deliver(batch, "gateway"));
	};

	deps.interventionClient.onStatus((state: AgentRunState) => {
		if (!lifecycle.stopped()) collector.accept({ type: "agent-status", state });
	});
	deps.interventionClient.onText((text) => {
		if (!lifecycle.stopped()) collector.accept({ type: "agent-text", text });
	});
	deps.interventionClient.onConnectionChange((state) => {
		if (lifecycle.stopped()) return;
		if (state === "connected") {
			if (interventionConnected) return;
			interventionConnected = true;
			deps.log(`${PREFIX} intervention: connected`);
			resume();
			return;
		}
		if (!interventionConnected) return;
		interventionConnected = false;
		deps.log(`${PREFIX} intervention: disconnected`);
		pause();
	});
	deps.gatewaySource.onMessages((messages) => {
		if (lifecycle.stopped()) return;
		if (!interventionConnected || !gatewayConnected) {
			gatewayBacklog.push([...messages]);
			return;
		}
		enqueue(() => deliver(messages, "gateway"));
	});
	deps.gatewaySource.onReady(() => {
		if (lifecycle.stopped()) return;
		gatewayConnected = true;
		deps.log(`${PREFIX} gateway ready`);
		if (interventionConnected) resume();
	});
	deps.gatewaySource.onDisconnect(() => {
		if (lifecycle.stopped() || !gatewayConnected) return;
		gatewayConnected = false;
		pause();
	});
	deps.gatewaySource.onResume(() => {
		if (lifecycle.stopped()) return;
		gatewayConnected = true;
		if (interventionConnected) resume();
		else enqueueCatchup();
	});

	queue.pause();
	catchup.pause();
	deps.interventionClient.connect();
	catchup.start();
	try {
		await deps.gatewaySource.start();
	} catch (error) {
		await lifecycle.stop();
		throw error;
	}
	const gatewayState = deps.gatewaySource.state();
	gatewayConnected = gatewayState !== "stopped";
	if (gatewayState === "disabled") deps.log(`${PREFIX} gateway disabled`);

	return {
		settled: async () => {
			await delivery;
			await outbound;
			await delivery;
			await outbound;
		},
		stop: lifecycle.stop,
	};
}

export async function main(options?: MainOptions): Promise<void> {
	const boundary = options ?? {
		env: process.env,
		dependencies: createRealBridgeDependencies,
		exit: (code: number) => {
			process.exitCode = code;
		},
		stderr: console.error,
	};
	const parsed = parseBridgeConfig(boundary.env);
	if (parsed.kind === "error") {
		boundary.stderr(parsed.issues);
		boundary.exit(2);
		return;
	}
	try {
		const runtime = await runBridge(
			parsed.config,
			boundary.dependencies(parsed.config),
		);
		const shutdown = (): void => {
			void runtime.stop();
		};
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	} catch (error) {
		boundary.stderr(
			`${PREFIX} fatal: ${describeBridgeError(error, parsed.config.token)}`,
		);
		boundary.exit(1);
	}
}

if (import.meta.main) await main();
