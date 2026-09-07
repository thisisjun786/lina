import { expect } from "bun:test";
import type { DiscordCursorSource } from "../src/adapters/discord.ts";
import type { DiscordCursor } from "../src/discord/cursor-store.ts";
import type { DiscordRest } from "../src/discord/rest.ts";
import {
	type DiscordMessage,
	DiscordMessageSchema,
} from "../src/discord/schemas.ts";

export const TEST_CHANNEL = "123";
const STAMP = "2026-09-04T12:00:00+00:00";

export function cursorAt(lastSeenMessageId: string): DiscordCursor {
	return {
		version: 1,
		channelId: TEST_CHANNEL,
		lastSeenMessageId,
	};
}

export function memoryCursor(lastSeenMessageId?: string): DiscordCursorSource {
	let current: DiscordCursor | undefined =
		lastSeenMessageId === undefined ? undefined : cursorAt(lastSeenMessageId);
	return {
		channelId: TEST_CHANNEL,
		read: () => Promise.resolve(current),
		write: (cursor) => {
			current = cursor;
			return Promise.resolve();
		},
	};
}

export function discordMessage(
	id: string,
	extra: { readonly replyTo?: string } = {},
): DiscordMessage {
	const replyTo = extra.replyTo;
	return DiscordMessageSchema.parse({
		id,
		channel_id: TEST_CHANNEL,
		author: { id: "9" },
		content: `m${id}`,
		timestamp: STAMP,
		...(replyTo === undefined
			? {}
			: { message_reference: { message_id: replyTo } }),
	});
}

function unused(): Promise<never> {
	return Promise.reject(new Error("unused DiscordRest method"));
}

export type FakeRest = {
	readonly rest: DiscordRest;
	readonly afterIds: string[];
	readonly limits: number[];
	readonly latestCalls: () => number;
};

export function fakeRest(script: {
	readonly latest?: DiscordMessage | undefined;
	readonly pages: Record<string, readonly DiscordMessage[]>;
	readonly malformedByAfter?: Record<string, number>;
	readonly shouldFail?: () => Error | undefined;
}): FakeRest {
	const afterIds: string[] = [];
	const limits: number[] = [];
	let latestCalls = 0;
	let malformed = 0;
	const rest: DiscordRest = {
		getMe: () => unused(),
		getMessagesAfter: (channel, afterId, limit = 100) => {
			expect(channel).toBe(TEST_CHANNEL);
			afterIds.push(afterId);
			limits.push(limit);
			const failure = script.shouldFail?.();
			if (failure !== undefined) {
				return Promise.reject(failure);
			}
			malformed += script.malformedByAfter?.[afterId] ?? 0;
			return Promise.resolve(script.pages[afterId] ?? []);
		},
		getLatestMessage: (channel) => {
			expect(channel).toBe(TEST_CHANNEL);
			latestCalls += 1;
			return Promise.resolve(script.latest);
		},
		createMessage: () => unused(),
		addReaction: () => unused(),
		deleteOwnReaction: () => unused(),
		malformedMessageCount: () => malformed,
	};
	return { rest, afterIds, limits, latestCalls: () => latestCalls };
}
