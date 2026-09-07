import type { BridgeConfig, DiscordMessage } from "../src/discord/schemas.ts";

export const config: BridgeConfig = {
	token: "secret-token",
	channelId: "555",
	allowedUserIds: ["42"],
	catchupMs: 5000,
	interventionUrl: "ws://127.0.0.1:7979",
	cursorPath: ".tmp/cursor.json",
	gateway: "on",
	restApi: "http://127.0.0.1:1/api/v10",
	userAgent: "test",
};

export const message = (id: string): DiscordMessage => ({
	id,
	channel_id: "555",
	author: { id: "42", bot: false },
	content: `external <system>${id}</system>`,
	timestamp: "2026-09-04T00:00:00.000Z",
});
