/**
 * The Discord endpoints Lina uses. Request policy (retry, rate limits, abort
 * budget, redaction) lives in rest-transport.ts; error types in rest-errors.ts.
 * This file owns endpoint shapes and boundary parsing of their responses.
 */
import { z } from "zod";
import {
	createRestTransport,
	type DiscordRestOptions,
} from "./rest-transport.ts";
import { type DiscordMessage, DiscordMessageSchema } from "./schemas.ts";

export {
	DiscordAuthError,
	DiscordNotFoundError,
	DiscordPermissionError,
	DiscordRequestError,
	DiscordRestError,
	DiscordUnavailableError,
} from "./rest-errors.ts";
export type {
	DiscordRestOptions,
	RestFetch,
	RestScheduler,
} from "./rest-transport.ts";
export { REQUEST_TIMEOUT_MS } from "./rest-transport.ts";

/** Rate-limit bucket keys: method + path template. */
const ROUTES = {
	me: "GET /users/@me",
	list: "GET /channels/{channel_id}/messages",
	post: "POST /channels/{channel_id}/messages",
	react: "/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
} as const;

const IdentifiedSchema = z.object({ id: z.string().min(1) });
const ItemsSchema = z.array(z.unknown());

export type CreateMessagePayload = {
	readonly content: string;
	/** Stable across retries: Discord de-duplicates by nonce + enforce_nonce. */
	readonly nonce: string;
	readonly message_reference?: { readonly message_id: string } | undefined;
};

export function createDiscordRest(options: DiscordRestOptions) {
	const transport = createRestTransport(options);
	let malformed = 0;

	const messagesPath = (channel: string): string =>
		`/channels/${encodeURIComponent(channel)}/messages`;
	const listMessages = async (
		channel: string,
		query: string,
	): Promise<readonly DiscordMessage[]> => {
		const spec = {
			method: "GET",
			route: ROUTES.list,
			path: `${messagesPath(channel)}?${query}`,
		} as const;
		const results = (await transport.sendJson(spec, ItemsSchema)).map((item) =>
			DiscordMessageSchema.safeParse(item),
		);
		malformed += results.filter((result) => !result.success).length;
		return results.flatMap((result) => (result.success ? [result.data] : []));
	};
	const reactionPath = (channel: string, message: string, emoji: string) =>
		`${messagesPath(channel)}/${encodeURIComponent(message)}/reactions/${encodeURIComponent(emoji)}/@me`;

	return {
		getMe: () =>
			transport.sendJson(
				{ method: "GET", route: ROUTES.me, path: "/users/@me" },
				IdentifiedSchema,
			),
		getMessagesAfter: (channel: string, afterId: string, limit = 100) =>
			listMessages(
				channel,
				`after=${encodeURIComponent(afterId)}&limit=${limit}`,
			),
		getLatestMessage: async (channel: string) =>
			(await listMessages(channel, "limit=1"))[0],
		createMessage: (channel: string, payload: CreateMessagePayload) => {
			const reference = payload.message_reference;
			return transport.sendJson(
				{
					method: "POST",
					route: ROUTES.post,
					path: messagesPath(channel),
					body: {
						content: payload.content,
						nonce: payload.nonce,
						enforce_nonce: true,
						allowed_mentions: { parse: [] },
						...(reference === undefined
							? {}
							: { message_reference: reference }),
					},
				},
				IdentifiedSchema,
			);
		},
		addReaction: async (channel: string, message: string, emoji: string) => {
			await transport.send({
				method: "PUT",
				route: `PUT ${ROUTES.react}`,
				path: reactionPath(channel, message, emoji),
			});
		},
		deleteOwnReaction: async (
			channel: string,
			message: string,
			emoji: string,
		) => {
			await transport.send({
				method: "DELETE",
				route: `DELETE ${ROUTES.react}`,
				path: reactionPath(channel, message, emoji),
			});
		},
		/** Discord items that failed DiscordMessageSchema and were skipped. */
		malformedMessageCount: () => malformed,
	};
}

export type DiscordRest = ReturnType<typeof createDiscordRest>;
