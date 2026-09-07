/**
 * Shared fixtures for the three inbound-queue suites. Not a test file: bun only
 * collects *.test.ts, so this module owns the fakes and the per-test cursor
 * directory while each suite owns one responsibility of the queue.
 */
import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatFrame } from "../src/bridge/frames.ts";
import type { AckResult } from "../src/bridge/intervention-client.ts";
import { CursorStore } from "../src/discord/cursor-store.ts";
import {
	createInboundQueue,
	type InboundQueue,
	type ReactionSink,
} from "../src/discord/inbound-queue.ts";
import {
	type DiscordMessage,
	DiscordMessageSchema,
} from "../src/discord/schemas.ts";

export const CHANNEL = "123";
export const BOT = "900";
export const HUMAN = "42";
export const OTHER_BOT = "777";
export const STRANGER = "555";

/** Fixtures cross the same Zod boundary the sources use, so shapes stay honest. */
export function msg(
	id: string,
	over: { author?: string; content?: string; bot?: boolean } = {},
): DiscordMessage {
	return DiscordMessageSchema.parse({
		id,
		channel_id: CHANNEL,
		author: { id: over.author ?? HUMAN, bot: over.bot ?? false },
		content: over.content ?? `text-${id}`,
		timestamp: "2026-09-04T09:00:00.000+00:00",
	});
}

/** Awaitable FIFO: suites await the next arrival instead of sleeping. */
export function createSignal<T>() {
	const items: T[] = [];
	const waiters: ((item: T) => void)[] = [];
	return {
		push(item: T): void {
			const waiter = waiters.shift();
			if (waiter === undefined) items.push(item);
			else waiter(item);
		},
		next(): Promise<T> {
			const item = items.shift();
			if (item !== undefined) return Promise.resolve(item);
			return new Promise<T>((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

/** What the agent does with an id: ack now, hold until the suite acks, or fail. */
export type AckPolicy = "ack" | "hold" | Error;

export type Agent = {
	ids(): string[];
	/** Highest number of injects outstanding at once - one, unless serialization broke. */
	peakInFlight(): number;
	nextFrame(): Promise<ChatFrame>;
	ack(id: string): void;
	inject(frame: ChatFrame): Promise<AckResult>;
};

function createAgent(policy: (id: string) => AckPolicy): Agent {
	const frames: ChatFrame[] = [];
	const arrivals = createSignal<ChatFrame>();
	const held = new Map<string, PromiseWithResolvers<AckResult>>();
	let inFlight = 0;
	let peak = 0;
	return {
		ids: () => frames.map((frame) => frame.id),
		peakInFlight: () => peak,
		nextFrame: () => arrivals.next(),
		ack(id: string): void {
			const deferred = held.get(id);
			if (deferred === undefined) return;
			held.delete(id);
			inFlight -= 1;
			deferred.resolve({ id });
		},
		inject(frame: ChatFrame): Promise<AckResult> {
			frames.push(frame);
			arrivals.push(frame);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			const verdict = policy(frame.id);
			if (verdict === "ack") {
				inFlight -= 1;
				return Promise.resolve({ id: frame.id });
			}
			if (verdict !== "hold") {
				inFlight -= 1;
				return Promise.reject(verdict);
			}
			const deferred = Promise.withResolvers<AckResult>();
			held.set(frame.id, deferred);
			return deferred.promise;
		},
	};
}

export type QueueExtras = {
	readonly allowed?: readonly string[];
	readonly react?: ReactionSink;
};

export type Harness = {
	/** A fresh queue over this test's cursor file, plus the agent behind it. */
	setup(
		policy?: (id: string) => AckPolicy,
		extras?: QueueExtras,
	): { agent: Agent; queue: InboundQueue };
	cursor(): CursorStore;
	lastSeen(): Promise<string | undefined>;
};

/** Registers the per-test cursor directory; every suite calls this once. */
export function useInboundQueueHarness(): Harness {
	let directory = "";
	let path = "";
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "lina-inbound-"));
		path = join(directory, "cursor.json");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});
	return {
		cursor: () => new CursorStore(path, CHANNEL),
		lastSeen: async () =>
			(await new CursorStore(path, CHANNEL).read())?.lastSeenMessageId,
		setup(policy = () => "ack", extras = {}) {
			const agent = createAgent(policy);
			const queue = createInboundQueue({
				botUserId: BOT,
				allowedUserIds: extras.allowed ?? [HUMAN],
				cursor: new CursorStore(path, CHANNEL),
				inject: agent.inject,
				react: extras.react ?? { accept: () => Promise.resolve() },
				log: (): void => undefined,
			});
			return { agent, queue };
		},
	};
}
