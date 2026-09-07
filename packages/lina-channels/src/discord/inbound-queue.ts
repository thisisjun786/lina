/**
 * The one inbound FIFO both Discord sources feed. It owns delivery order and
 * the ACK-driven cursor: a message leaves the queue only after the agent acked
 * it or a filter skipped it, so a crash replays one prompt instead of losing
 * it. The cursor file stays the single source of truth - nothing here caches a
 * last-seen id.
 */
import { assertNever, type ChatFrame } from "../bridge/frames.ts";
import type { AckResult } from "../bridge/intervention-client.ts";
import type { CursorStore } from "./cursor-store.ts";
import type { DiscordMessage } from "./schemas.ts";

/** Ids remembered for cross-source dedupe; the oldest insertion is evicted first. */
const SEEN_LIMIT = 1000;

export type InboundSource = "gateway" | "catchup";

/** The 👀 marker; best-effort, so a failure is logged and never blocks delivery. */
export type ReactionSink = {
	accept(messageId: string): Promise<void>;
};

export type InboundQueueOptions = {
	readonly botUserId: string;
	readonly allowedUserIds: readonly string[];
	readonly cursor: CursorStore;
	readonly inject: (frame: ChatFrame) => Promise<AckResult>;
	readonly react: ReactionSink;
	readonly log?: (message: string) => void;
};

export interface InboundQueue {
	/** Admits unseen ids above the cursor and appends them oldest-first. */
	offer(
		messages: readonly DiscordMessage[],
		source: InboundSource,
	): Promise<void>;
	/** Delivers from the head until the queue empties, a send fails, or a pause. */
	drain(): Promise<void>;
	pause(): void;
	resume(): void;
	head(): DiscordMessage | undefined;
	size(): number;
	/**
	 * The newest id the agent acked. Skipped messages never set it, so todo 12
	 * can reply to the message that actually started the turn rather than to the
	 * cursor, which also counts bot and denied posts.
	 */
	lastAckedMessageId(): string | undefined;
}

/** Why a message never reaches the agent; `reason` exists for the log line only. */
type Verdict =
	| { readonly kind: "accept" }
	| { readonly kind: "skip"; readonly reason: string };

function bySnowflake(left: DiscordMessage, right: DiscordMessage): number {
	const first = BigInt(left.id);
	const second = BigInt(right.id);
	if (first < second) return -1;
	return first > second ? 1 : 0;
}

function failureReason(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}

export function createInboundQueue(options: InboundQueueOptions): InboundQueue {
	const log =
		options.log ??
		((message: string) => console.error(`[inbound-queue] ${message}`));
	const allowed = new Set(options.allowedUserIds);
	const seen = new Set<string>();
	const queue: DiscordMessage[] = [];
	let lastAcked: string | undefined;
	let paused = false;
	/** Serializes drains so two sources can never inject at the same time. */
	let draining: Promise<void> | undefined;

	function remember(id: string): void {
		seen.add(id);
		if (seen.size <= SEEN_LIMIT) return;
		const oldest = seen.values().next();
		if (oldest.done !== true) seen.delete(oldest.value);
	}

	function classify(message: DiscordMessage): Verdict {
		if (message.author.id === options.botUserId)
			return { kind: "skip", reason: "own message" };
		if (message.author.bot === true)
			return { kind: "skip", reason: "another bot" };
		if (!allowed.has(message.author.id))
			return {
				kind: "skip",
				reason: `author ${message.author.id} is not allowed`,
			};
		if (message.content.trim() === "")
			return { kind: "skip", reason: "whitespace-only content" };
		return { kind: "accept" };
	}

	/** True when the agent acked and the cursor moved past this message. */
	async function deliver(message: DiscordMessage): Promise<boolean> {
		try {
			await options.inject({
				type: "chat",
				id: message.id,
				text: message.content,
			});
		} catch (error) {
			log(`kept ${message.id} at the head: ${failureReason(error)}`);
			return false;
		}
		lastAcked = message.id;
		await options.cursor.advance(message.id);
		options.react.accept(message.id).catch((error: unknown) => {
			log(`accept reaction failed for ${message.id}: ${failureReason(error)}`);
		});
		return true;
	}

	async function runDrain(): Promise<void> {
		while (!paused) {
			const message = queue[0];
			if (message === undefined) return;
			const verdict = classify(message);
			switch (verdict.kind) {
				case "skip":
					log(`skipped ${message.id}: ${verdict.reason}`);
					await options.cursor.advance(message.id);
					break;
				case "accept":
					if (!(await deliver(message))) return;
					break;
				default:
					assertNever(verdict);
			}
			queue.shift();
		}
	}

	return {
		async offer(messages, source): Promise<void> {
			const cursor = await options.cursor.read();
			const lastSeen = BigInt(cursor?.lastSeenMessageId ?? "0");
			const admitted: DiscordMessage[] = [];
			for (const message of messages) {
				if (BigInt(message.id) <= lastSeen) {
					log(`dropped ${message.id} from ${source}: at or below the cursor`);
					continue;
				}
				if (seen.has(message.id)) {
					log(`dropped ${message.id} from ${source}: already seen`);
					continue;
				}
				remember(message.id);
				admitted.push(message);
			}
			queue.push(...admitted.sort(bySnowflake));
		},
		drain(): Promise<void> {
			// Chained, never shared: a drain requested mid-flight still sees the
			// messages that arrived after the running pass read the head.
			const next = (draining ?? Promise.resolve()).then(runDrain);
			draining = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		},
		pause(): void {
			paused = true;
		},
		resume(): void {
			paused = false;
		},
		head: () => queue[0],
		size: () => queue.length,
		lastAckedMessageId: () => lastAcked,
	};
}
