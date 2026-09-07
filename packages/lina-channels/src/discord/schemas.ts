import { z } from "zod";

const snowflakePattern = /^[1-9]\d{0,19}$/;

export const SnowflakeSchema = z
	.string()
	.regex(snowflakePattern)
	.refine(
		(value) =>
			!snowflakePattern.test(value) || BigInt(value) <= 0xffffffffffffffffn,
		{ message: "invalid Discord snowflake" },
	);

const MessageReferenceSchema = z.object({
	message_id: SnowflakeSchema.optional(),
});

export const DiscordMessageSchema = z.object({
	id: SnowflakeSchema,
	channel_id: SnowflakeSchema,
	author: z.object({
		id: SnowflakeSchema,
		bot: z.boolean().optional(),
	}),
	content: z.string(),
	timestamp: z.iso.datetime({ offset: true }),
	message_reference: MessageReferenceSchema.optional(),
});

export type DiscordMessage = z.infer<typeof DiscordMessageSchema>;

export const AllowedIdsSchema = z
	.string()
	.default("")
	.transform((value) =>
		value.trim() === "" ? [] : value.split(",").map((id) => id.trim()),
	)
	.pipe(
		z.array(SnowflakeSchema).refine((ids) => new Set(ids).size === ids.length, {
			message: "allowlist ids must be unique",
		}),
	);

const BridgeConfigInputSchema = z.object({
	DISCORD_BOT_TOKEN: z.string().min(1),
	DISCORD_CHANNEL_ID: SnowflakeSchema,
	LINA_DISCORD_ALLOWED_USER_IDS: AllowedIdsSchema,
	LINA_DISCORD_CATCHUP_MS: z.coerce.number().int().min(5000).default(60000),
	LINA_INTERVENTION_URL: z
		.url()
		.default("ws://127.0.0.1:7979")
		.refine(
			(value) => value.startsWith("ws://") || value.startsWith("wss://"),
			{
				message: "intervention URL must use ws:// or wss://",
			},
		),
	LINA_DISCORD_CURSOR_PATH: z
		.string()
		.default(".lina-sync/discord-cursor.json"),
	LINA_DISCORD_GATEWAY: z.enum(["on", "off"]).default("on"),
	LINA_DISCORD_REST_API: z
		.url()
		.default("https://discord.com/api/v10")
		.refine(
			(value) => value.startsWith("http://") || value.startsWith("https://"),
			{
				message: "REST API URL must use http:// or https://",
			},
		),
	LINA_DISCORD_USER_AGENT: z
		.string()
		.default("LinaBot/0.1 (https://github.com/thisisjun786/Lina)"),
});

export const BridgeConfigSchema = BridgeConfigInputSchema.transform(
	(value) => ({
		token: value.DISCORD_BOT_TOKEN,
		channelId: value.DISCORD_CHANNEL_ID,
		allowedUserIds: value.LINA_DISCORD_ALLOWED_USER_IDS,
		catchupMs: value.LINA_DISCORD_CATCHUP_MS,
		interventionUrl: value.LINA_INTERVENTION_URL,
		cursorPath: value.LINA_DISCORD_CURSOR_PATH,
		gateway: value.LINA_DISCORD_GATEWAY,
		restApi: value.LINA_DISCORD_REST_API,
		userAgent: value.LINA_DISCORD_USER_AGENT,
	}),
);

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;
export type BridgeConfigResult =
	| { readonly kind: "ok"; readonly config: BridgeConfig }
	| { readonly kind: "error"; readonly issues: readonly z.core.$ZodIssue[] };

export function parseBridgeConfig(
	env: Record<string, string | undefined>,
): BridgeConfigResult {
	const result = BridgeConfigSchema.safeParse(env);
	return result.success
		? { kind: "ok", config: result.data }
		: { kind: "error", issues: result.error.issues };
}
