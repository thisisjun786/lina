/**
 * Realtime inbound side of the Discord loop. discord.js lives behind
 * `clientFactory` so every test drives a plain object; this file is the ONLY
 * place in src/ that may import discord.js.
 */
import { Client, GatewayIntentBits } from "discord.js";
import { z } from "zod";
import { type DiscordMessage, DiscordMessageSchema } from "./schemas.ts";

/** Emitted verbatim so the operator knows which Developer Portal switch is off. */
export const MISSING_CONTENT_LOG =
	"gateway message without content: enable Message Content Intent";

export type GatewayEventName =
	| "ready"
	| "clientReady"
	| "messageCreate"
	| "shardDisconnect"
	| "shardResume"
	| "error";

/** The discord.js Client surface this source uses, and nothing more. */
export type GatewayClientLike = {
	on(
		event: GatewayEventName,
		handler: (...args: readonly unknown[]) => void,
	): void;
	login(token: string): Promise<unknown>;
	destroy(): Promise<void> | void;
	readonly user: { readonly id: string } | null;
};

export type GatewayClientOptions = {
	readonly restApiBase?: string | undefined;
};

export type GatewaySourceOptions = {
	readonly token: string;
	readonly channelId: string;
	/** "off" keeps the client unconstructed: catch-up alone carries inbound. */
	readonly gateway?: "on" | "off";
	readonly restApiBase?: string | undefined;
	readonly clientFactory?: (options: GatewayClientOptions) => GatewayClientLike;
	readonly log?: (message: string) => void;
};

export type GatewaySourceState = "disabled" | "stopped" | "running";

export type MessagesListener = (messages: readonly DiscordMessage[]) => void;
export type ReadyListener = (ready: { readonly botUserId: string }) => void;

export interface GatewaySource {
	start(): Promise<void>;
	stop(): Promise<void>;
	state(): GatewaySourceState;
	onMessages(callback: MessagesListener): void;
	onReady(callback: ReadyListener): void;
	onDisconnect(callback: () => void): void;
	onResume(callback: () => void): void;
}

/**
 * A discord.js Message as this source reads it. `content` is nullish-tolerant on
 * purpose: without the Message Content Intent the field arrives absent OR null
 * depending on the payload, and both deserve the operator-facing guidance rather
 * than a schema dump. An empty string is a real attachment-only message and is
 * delivered normally.
 */
const GatewayMessageSchema = z.object({
	id: z.string(),
	channelId: z.string(),
	author: z.object({ id: z.string(), bot: z.boolean().optional() }),
	content: z.string().nullish(),
	createdAt: z.date(),
});

/** Field names only: message text is untrusted data and never reaches a log. */
function issueFields(error: z.ZodError): string {
	return error.issues.map((issue) => issue.path.join(".")).join(", ");
}

/** External failure text with the bot token stripped; used on every logged error. */
function redactedError(payload: unknown, token: string): string {
	const text = payload instanceof Error ? payload.message : String(payload);
	return text.split(token).join("<redacted>");
}

export function createGatewaySource(
	options: GatewaySourceOptions,
): GatewaySource {
	const log =
		options.log ??
		((message: string) => console.error(`[gateway-source] ${message}`));
	const messageListeners: MessagesListener[] = [];
	const readyListeners: ReadyListener[] = [];
	const disconnectListeners: (() => void)[] = [];
	const resumeListeners: (() => void)[] = [];

	let client: GatewayClientLike | undefined;
	/** discord.js 14 fires `ready` AND its `clientReady` successor for one event. */
	let readyEmitted = false;

	function handleReady(): void {
		if (readyEmitted) return;
		const user = client?.user;
		if (user === null || user === undefined) {
			log("ready fired without a bot user id");
			return;
		}
		readyEmitted = true;
		for (const listener of readyListeners) listener({ botUserId: user.id });
	}

	function handleMessageCreate(payload: unknown): void {
		const raw = GatewayMessageSchema.safeParse(payload);
		if (!raw.success) {
			log(`ignored a malformed gateway message: ${issueFields(raw.error)}`);
			return;
		}
		if (raw.data.channelId !== options.channelId) return;
		const content = raw.data.content;
		if (content === undefined || content === null) {
			log(MISSING_CONTENT_LOG);
			return;
		}
		const message = DiscordMessageSchema.safeParse({
			id: raw.data.id,
			channel_id: raw.data.channelId,
			author: { id: raw.data.author.id, bot: raw.data.author.bot },
			content,
			timestamp: raw.data.createdAt.toISOString(),
		});
		if (!message.success) {
			log(
				`ignored a gateway message failing the Discord schema: ${issueFields(message.error)}`,
			);
			return;
		}
		for (const listener of messageListeners) listener([message.data]);
	}

	function register(created: GatewayClientLike): void {
		created.on("ready", handleReady);
		created.on("clientReady", handleReady);
		created.on("messageCreate", (...args) => {
			handleMessageCreate(args[0]);
		});
		created.on("shardDisconnect", () => {
			readyEmitted = false;
			for (const listener of disconnectListeners) listener();
		});
		created.on("shardResume", () => {
			for (const listener of resumeListeners) listener();
		});
		created.on("error", (...args) => {
			log(`gateway error: ${redactedError(args[0], options.token)}`);
		});
	}

	/**
	 * Tear down a client that never logged in. Destroy is best effort: its own
	 * failure is logged, never allowed to mask the login error the caller needs.
	 */
	async function discard(created: GatewayClientLike): Promise<void> {
		// no-excuse-ok: catch
		try {
			await created.destroy();
		} catch (error) {
			log(
				`destroy after a failed login: ${redactedError(error, options.token)}`,
			);
		}
	}

	return {
		async start(): Promise<void> {
			if (options.gateway === "off") {
				log("gateway disabled");
				return;
			}
			if (client !== undefined) return;
			const created = (options.clientFactory ?? createDiscordClient)({
				restApiBase: options.restApiBase,
			});
			client = created;
			register(created);
			try {
				await created.login(options.token);
			} catch (error) {
				// A half-open client would make state() lie and turn every retry into
				// a no-op, so the source returns to "stopped" and rethrows.
				client = undefined;
				readyEmitted = false;
				await discard(created);
				throw error;
			}
		},
		async stop(): Promise<void> {
			const current = client;
			client = undefined;
			readyEmitted = false;
			if (current !== undefined) await current.destroy();
		},
		state: () =>
			options.gateway === "off"
				? "disabled"
				: client === undefined
					? "stopped"
					: "running",
		onMessages(callback): void {
			messageListeners.push(callback);
		},
		onReady(callback): void {
			readyListeners.push(callback);
		},
		onDisconnect(callback): void {
			disconnectListeners.push(callback);
		},
		onResume(callback): void {
			resumeListeners.push(callback);
		},
	};
}

/** Intents 33281 — the exact bitfield the Bun handshake smoke proved (todo 1). */
function createDiscordClient(options: GatewayClientOptions): GatewayClientLike {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
		...(options.restApiBase === undefined
			? {}
			: { rest: { api: options.restApiBase.replace(/\/v\d+\/?$/, "") } }),
	});
	return {
		on: (event, handler) => {
			client.on(event, handler);
		},
		login: (token) => client.login(token),
		destroy: () => client.destroy(),
		get user() {
			return client.user;
		},
	};
}
