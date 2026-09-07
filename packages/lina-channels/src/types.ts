import { z } from "zod";

type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type MessageId = Brand<string, "MessageId">;
export type ChannelId = Brand<string, "ChannelId">;

export const CHANNELS = ["discord", "telegram"] as const;
export type Channel = (typeof CHANNELS)[number];

const SessionIdSchema = z.custom<SessionId>(
	(value) => typeof value === "string",
);
const MessageIdSchema = z.custom<MessageId>(
	(value) => typeof value === "string",
);
const ChannelIdSchema = z.custom<ChannelId>(
	(value) => typeof value === "string",
);
const ChannelSchema = z.enum(CHANNELS);

export type InboundMessage = {
	readonly channel: Channel;
	readonly messageId: MessageId;
	readonly channelId: ChannelId;
	readonly authorId: string;
	readonly text: string;
	readonly receivedAt: string;
	readonly replyTo?: MessageId | undefined;
};

export type RegistryEntry = {
	readonly messageId: MessageId;
	readonly sessionId: SessionId;
	readonly channel: Channel;
	readonly channelId: ChannelId;
	readonly recordedAt: string;
};

export const InboundMessageSchema = z.object({
	channel: ChannelSchema,
	messageId: MessageIdSchema,
	channelId: ChannelIdSchema,
	authorId: z.string(),
	text: z.string(),
	receivedAt: z.string(),
	replyTo: MessageIdSchema.optional(),
});

export const RegistryEntrySchema = z.object({
	messageId: MessageIdSchema,
	sessionId: SessionIdSchema,
	channel: ChannelSchema,
	channelId: ChannelIdSchema,
	recordedAt: z.string(),
});

export class NotImplementedError extends Error {
	constructor(feature: string) {
		super(feature);
		this.name = "NotImplementedError";
	}
}
