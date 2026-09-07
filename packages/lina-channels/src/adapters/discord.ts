import type { CursorStore } from "../discord/cursor-store.ts";
import type { DiscordRest } from "../discord/rest.ts";
import type { DiscordMessage } from "../discord/schemas.ts";
import type { ChannelAdapter } from "../reply-listener.ts";
import { type InboundMessage, InboundMessageSchema } from "../types.ts";

const PAGE_SIZE = 100 as const;
const BOOTSTRAP_SENTINEL = "0" as const;

export type DiscordCursorSource = Pick<
	CursorStore,
	"read" | "write" | "channelId"
>;

export class DiscordAdapter implements ChannelAdapter {
	readonly channel = "discord" as const;
	readonly rest: DiscordRest;
	readonly channelId: string;
	readonly cursor: DiscordCursorSource;

	constructor(options: {
		readonly rest: DiscordRest;
		readonly channelId: string;
		readonly cursor: DiscordCursorSource;
	}) {
		this.rest = options.rest;
		this.channelId = options.channelId;
		this.cursor = options.cursor;
	}

	async bootstrap(): Promise<void> {
		const current = await this.cursor.read();
		if (current !== undefined) {
			return;
		}
		const latest = await this.rest.getLatestMessage(this.channelId);
		await this.cursor.write({
			version: 1,
			channelId: this.cursor.channelId,
			lastSeenMessageId: latest?.id ?? BOOTSTRAP_SENTINEL,
		});
	}

	async pollRaw(): Promise<readonly DiscordMessage[]> {
		const cursor = await this.cursor.read();
		if (cursor === undefined) {
			return [];
		}
		let afterId = cursor.lastSeenMessageId;
		const collected: DiscordMessage[] = [];
		for (;;) {
			const malformedBefore = this.rest.malformedMessageCount();
			const page = await this.rest.getMessagesAfter(
				this.channelId,
				afterId,
				PAGE_SIZE,
			);
			const raw =
				page.length + (this.rest.malformedMessageCount() - malformedBefore);
			collected.push(...page);
			if (raw < PAGE_SIZE) {
				return collected;
			}
			let nextAfter: string | undefined;
			for (const message of page) {
				if (nextAfter === undefined || BigInt(message.id) > BigInt(nextAfter)) {
					nextAfter = message.id;
				}
			}
			if (nextAfter === undefined || BigInt(nextAfter) <= BigInt(afterId)) {
				return collected;
			}
			afterId = nextAfter;
		}
	}

	async poll(_since: string | undefined): Promise<readonly InboundMessage[]> {
		// Discord cursors are snowflakes owned by CursorStore
		const messages = await this.pollRaw();
		return messages.map((message) => {
			const replyTo = message.message_reference?.message_id;
			return InboundMessageSchema.parse({
				channel: "discord",
				messageId: message.id,
				channelId: message.channel_id,
				authorId: message.author.id,
				text: message.content,
				receivedAt: message.timestamp,
				...(replyTo === undefined ? {} : { replyTo }),
			});
		});
	}
}
