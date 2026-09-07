import type { ChannelAdapter } from "../reply-listener.ts";
import {
	type ChannelId,
	type InboundMessage,
	NotImplementedError,
} from "../types.ts";

export class TelegramAdapter implements ChannelAdapter {
	readonly channel = "telegram" as const;
	readonly botToken: string;
	readonly chatId: ChannelId;

	constructor(options: {
		readonly botToken: string;
		readonly chatId: ChannelId;
	}) {
		this.botToken = options.botToken;
		this.chatId = options.chatId;
	}

	poll(_since: string | undefined): Promise<readonly InboundMessage[]> {
		// Scaffold stub: Telegram Bot API polling is not implemented.
		throw new NotImplementedError("telegram poll");
	}
}
