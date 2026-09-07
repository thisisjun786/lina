import { z } from "zod";

export const BOT_ID = "555" as const;
export const BOT_TOKEN = "fake" as const;
export const CHANNEL_ID = "123" as const;
export const USER_ID = "777" as const;

export const InjectSchema = z
	.object({ authorId: z.string().min(1), content: z.string() })
	.strict();
export const FailPostsSchema = z
	.object({ count: z.number().int().min(1).max(3) })
	.strict();
export const DiscordPostSchema = z
	.object({
		content: z.string().min(1).max(2_000),
		nonce: z.string().regex(/^[0-9a-f]{25}$/),
		enforce_nonce: z.literal(true),
		allowed_mentions: z.object({ parse: z.tuple([]) }).strict(),
		message_reference: z.object({ message_id: z.string().min(1) }).strict(),
	})
	.strict();
export type DiscordPost = z.infer<typeof DiscordPostSchema>;

export type StoredMessage = {
	readonly id: string;
	readonly channel_id: string;
	readonly guild_id: string;
	readonly author: { readonly id: string; readonly bot: boolean };
	readonly content: string;
	readonly timestamp: string;
};
export type RestRequestRecord = {
	readonly method: string;
	readonly path: string;
	readonly body: unknown | undefined;
};
export type IdentifyRecord = {
	readonly token: string;
	readonly intents: number;
	readonly properties: {
		readonly os: string;
		readonly browser: string;
		readonly device: string;
	};
};
export type HandshakeSnapshot = {
	readonly queries: readonly string[];
	readonly identifies: readonly IdentifyRecord[];
	readonly heartbeatCount: number;
	readonly ackCount: number;
	readonly rejections: readonly string[];
};
export type FakeDiscordEvent =
	| { readonly kind: "request"; readonly request: RestRequestRecord }
	| { readonly kind: "catchup"; readonly after: string | undefined }
	| {
			readonly kind: "gateway";
			readonly state: "connected" | "identified" | "heartbeat" | "rejected";
			readonly detail?: string;
	  }
	| { readonly kind: "inject"; readonly message: StoredMessage }
	| {
			readonly kind: "post";
			readonly message: StoredMessage;
			readonly body: DiscordPost;
	  }
	| {
			readonly kind: "reaction";
			readonly method: "PUT" | "DELETE";
			readonly messageId: string;
			readonly emoji: string;
			readonly path: string;
	  };

export type JsonBody =
	| { readonly kind: "none" }
	| { readonly kind: "valid"; readonly value: unknown }
	| { readonly kind: "invalid" };

export function parseJsonBody(text: string): JsonBody {
	if (text.length === 0) return { kind: "none" };
	try {
		return { kind: "valid", value: JSON.parse(text) };
	} catch (error) {
		if (error instanceof SyntaxError) return { kind: "invalid" };
		throw error;
	}
}

export function jsonError(
	error: "invalid_json" | "invalid_body" | "not_found",
	status: number,
): Response {
	return Response.json({ error }, { status });
}
