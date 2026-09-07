import { z } from "zod";
import { gatewayBody } from "./fake-discord-gateway.ts";
import {
	BOT_ID,
	DiscordPostSchema,
	FailPostsSchema,
	type FakeDiscordEvent,
	InjectSchema,
	jsonError,
	parseJsonBody,
	type StoredMessage,
} from "./fake-discord-types.ts";

type RestOptions = {
	readonly emit: (event: FakeDiscordEvent) => void;
	readonly dispatch: (message: StoredMessage) => void;
};
type HandleOptions = { readonly request: Request; readonly port: number };
export type FakeDiscordRest = {
	readonly handle: (options: HandleOptions) => Promise<Response>;
};

type MessageSeed = {
	readonly channelId: string;
	readonly authorId: string;
	readonly content: string;
	readonly bot: boolean;
};

export function createFakeDiscordRest(options: RestOptions): FakeDiscordRest {
	const messages: StoredMessage[] = [];
	let nextId = 100;
	let failingPosts = 0;
	const makeMessage = (seed: MessageSeed): StoredMessage => ({
		id: String(nextId++),
		channel_id: seed.channelId,
		guild_id: "888",
		author: { id: seed.authorId, bot: seed.bot },
		content: seed.content,
		timestamp: new Date().toISOString(),
	});
	return {
		async handle({ request, port }): Promise<Response> {
			const url = new URL(request.url);
			const bodyText = request.method === "GET" ? "" : await request.text();
			const body = parseJsonBody(bodyText);
			options.emit({
				kind: "request",
				request: {
					method: request.method,
					path: `${url.pathname}${url.search}`,
					body:
						body.kind === "valid"
							? body.value
							: body.kind === "invalid"
								? bodyText
								: undefined,
				},
			});
			if (body.kind === "invalid") return jsonError("invalid_json", 400);
			if (request.method === "GET" && url.pathname === "/api/v10/users/@me")
				return Response.json({ id: BOT_ID, bot: true });
			if (request.method === "GET" && url.pathname === "/api/v10/gateway/bot")
				return Response.json(gatewayBody(port));
			if (request.method === "POST" && url.pathname === "/__control/inject") {
				const parsed = InjectSchema.safeParse(
					body.kind === "valid" ? body.value : undefined,
				);
				if (!parsed.success) return jsonError("invalid_body", 400);
				const message = makeMessage({
					channelId: url.searchParams.get("channelId") ?? "123",
					authorId: parsed.data.authorId,
					content: parsed.data.content,
					bot: false,
				});
				messages.push(message);
				options.emit({ kind: "inject", message });
				options.dispatch(message);
				return Response.json(message);
			}
			if (
				request.method === "POST" &&
				url.pathname === "/__control/fail-next-post"
			) {
				const parsed = FailPostsSchema.safeParse(
					body.kind === "valid" ? body.value : undefined,
				);
				if (!parsed.success) return jsonError("invalid_body", 400);
				failingPosts = parsed.data.count;
				return Response.json({ ok: true });
			}
			const list = url.pathname.match(
				/^\/api\/v10\/channels\/([^/]+)\/messages$/,
			);
			if (list !== null && request.method === "GET") {
				const channelId = decodeURIComponent(list[1] ?? "");
				const after = url.searchParams.get("after") ?? undefined;
				options.emit({ kind: "catchup", after });
				const eligible = messages.filter(
					(message) =>
						message.channel_id === channelId &&
						(after === undefined || BigInt(message.id) > BigInt(after)),
				);
				const limit = z.coerce
					.number()
					.int()
					.min(1)
					.max(100)
					.catch(50)
					.parse(url.searchParams.get("limit"));
				return Response.json(eligible.slice(-limit).reverse());
			}
			if (list !== null && request.method === "POST") {
				const parsed = DiscordPostSchema.safeParse(
					body.kind === "valid" ? body.value : undefined,
				);
				if (!parsed.success) return jsonError("invalid_body", 400);
				if (failingPosts > 0) {
					failingPosts -= 1;
					return Response.json({ error: "retry" }, { status: 503 });
				}
				const message = makeMessage({
					channelId: decodeURIComponent(list[1] ?? ""),
					authorId: BOT_ID,
					content: parsed.data.content,
					bot: true,
				});
				messages.push(message);
				options.emit({ kind: "post", message, body: parsed.data });
				return Response.json(message);
			}
			const reaction = url.pathname.match(
				/^\/api\/v10\/channels\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)\/@me$/,
			);
			if (
				reaction !== null &&
				(request.method === "PUT" || request.method === "DELETE")
			) {
				options.emit({
					kind: "reaction",
					method: request.method,
					messageId: decodeURIComponent(reaction[2] ?? ""),
					emoji: decodeURIComponent(reaction[3] ?? ""),
					path: url.pathname,
				});
				return new Response(null, { status: 204 });
			}
			return jsonError("not_found", 404);
		},
	};
}
