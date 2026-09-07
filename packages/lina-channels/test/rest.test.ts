import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
	createDiscordRest,
	DiscordAuthError,
	DiscordPermissionError,
	type RestFetch,
	type RestScheduler,
} from "../src/discord/rest.ts";

const TOKEN = "secret-token";

type FakeCall = {
	readonly url: string;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | undefined;
};

type ScriptedResponse = () => Response | Promise<Response>;

function json(
	status: number,
	payload: unknown,
	headers: Record<string, string> = {},
): ScriptedResponse {
	const all = { "content-type": "application/json", ...headers };
	return () => new Response(JSON.stringify(payload), { status, headers: all });
}

function networkFailure(message: string): ScriptedResponse {
	return () => Promise.reject(new Error(message));
}

const RequestBodySchema = z.object({
	content: z.string(),
	nonce: z.string(),
	enforce_nonce: z.boolean(),
	allowed_mentions: z.object({ parse: z.array(z.string()) }),
	message_reference: z.object({ message_id: z.string() }).optional(),
});

const validMessage = {
	id: "12",
	channel_id: "5",
	author: { id: "9" },
	content: "hi",
	timestamp: "2026-09-04T12:00:00+00:00",
};

/** A timer the client asked for; the per-attempt abort budget is cancelled. */
type FakeTimer = { readonly ms: number; cancelled: boolean };

const makeClient = (script: readonly ScriptedResponse[]) => {
	const calls: FakeCall[] = [];
	const timers: FakeTimer[] = [];
	const fetchImpl: RestFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? init.body : undefined,
		});
		const next = script[calls.length - 1];
		if (next === undefined) {
			throw new Error(`fake fetch: unscripted call ${calls.length}`);
		}
		return await next();
	};
	const scheduler: RestScheduler = {
		delay: (ms, handler) => {
			const entry: FakeTimer = { ms, cancelled: false };
			timers.push(entry);
			const timer = setTimeout(handler, 0);
			return () => {
				entry.cancelled = true;
				clearTimeout(timer);
			};
		},
	};
	const rest = createDiscordRest({
		token: TOKEN,
		userAgent: "LinaBot/test",
		fetch: fetchImpl,
		scheduler,
		clock: { now: () => 0 },
		baseUrl: "https://discord.test/api/v10",
	});
	return {
		rest,
		calls,
		/** Waits the policy actually served; cancelled abort budgets excluded. */
		policyWaits: (): readonly number[] =>
			timers.filter((timer) => !timer.cancelled).map((timer) => timer.ms),
	};
};

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

describe("Discord REST client", () => {
	it("sends Bot auth and user-agent when calling getMe", async () => {
		const { rest, calls } = makeClient([json(200, { id: "bot1" })]);

		const me = await rest.getMe();

		expect(me.id).toBe("bot1");
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe("https://discord.test/api/v10/users/@me");
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers.get("authorization")).toBe(`Bot ${TOKEN}`);
		expect(calls[0]?.headers.get("user-agent")).toBe("LinaBot/test");
		expect(calls[0]?.headers.get("content-type")).toBe("application/json");
	});

	it("parses messages and skips a malformed item when listing after a cursor", async () => {
		const { rest, calls } = makeClient([
			json(200, [
				validMessage,
				{ id: "not-a-snowflake" },
				{ ...validMessage, timestamp: "nope" },
			]),
		]);

		const messages = await rest.getMessagesAfter("5", "11");

		expect(messages.map((message) => message.id)).toEqual(["12"]);
		expect(rest.malformedMessageCount()).toBe(2);
		expect(calls[0]?.url).toBe(
			"https://discord.test/api/v10/channels/5/messages?after=11&limit=100",
		);
	});

	it("retries once after Retry-After when Discord answers 429", async () => {
		const { rest, calls, policyWaits } = makeClient([
			json(429, { message: "rate limited" }, { "retry-after": "1" }),
			json(200, { id: "bot1" }),
		]);

		const me = await rest.getMe();

		expect(me.id).toBe("bot1");
		expect(calls.length).toBe(2);
		expect(policyWaits()).toEqual([1000]);
	});

	it("backs off 1s then 2s and reuses the nonce when the network fails twice", async () => {
		const { rest, calls, policyWaits } = makeClient([
			networkFailure("ECONNRESET"),
			networkFailure("ECONNRESET"),
			json(200, { id: "m9" }),
		]);

		const created = await rest.createMessage("5", {
			content: "hello",
			nonce: "n1",
			message_reference: { message_id: "12" },
		});

		expect(created.id).toBe("m9");
		expect(policyWaits()).toEqual([1000, 2000]);
		const bodies = calls.map((call) =>
			RequestBodySchema.parse(JSON.parse(call.body ?? "{}")),
		);
		expect(bodies.map((body) => body.nonce)).toEqual(["n1", "n1", "n1"]);
		expect(bodies[0]?.enforce_nonce).toBe(true);
		expect(bodies[0]?.allowed_mentions).toEqual({ parse: [] });
		expect(bodies[0]?.message_reference).toEqual({ message_id: "12" });
	});

	it("throws DiscordAuthError without retry when Discord answers 401", async () => {
		const { rest, calls } = makeClient([json(401, { message: "no" })]);

		const error = await rest.getMe().catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(DiscordAuthError);
		expect(calls.length).toBe(1);
	});

	it("throws DiscordPermissionError when 403", async () => {
		const { rest, calls } = makeClient([json(403, { message: "denied" })]);

		const error = await rest
			.addReaction("5", "12", "\u{1F440}")
			.catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(DiscordPermissionError);
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(
			"https://discord.test/api/v10/channels/5/messages/12/reactions/%F0%9F%91%80/@me",
		);
		expect(calls[0]?.method).toBe("PUT");
	});

	it("pre-waits until reset when remaining is 1 on the same route", async () => {
		const { rest, calls, policyWaits } = makeClient([
			json(200, [], {
				"x-ratelimit-remaining": "1",
				"x-ratelimit-reset-after": "2",
			}),
			json(200, []),
		]);

		await rest.getMessagesAfter("5", "1");
		const beforeSecondCall = policyWaits();
		await rest.getMessagesAfter("5", "2");

		expect(beforeSecondCall).toEqual([]);
		expect(policyWaits()).toEqual([2000]);
		expect(calls.length).toBe(2);
	});

	it("pre-waits ten seconds when the bucket is empty without a reset header", async () => {
		const { rest, calls, policyWaits } = makeClient([
			json(200, [], { "x-ratelimit-remaining": "0" }),
			json(200, []),
		]);

		await rest.getMessagesAfter("5", "1");
		await rest.getMessagesAfter("5", "2");

		expect(policyWaits()).toEqual([10_000]);
		expect(calls.length).toBe(2);
	});

	it("does not leak a token prefix when the token straddles the detail limit", async () => {
		const padding = "y".repeat(180);
		const { rest } = makeClient([
			json(401, { message: `${padding}${TOKEN} trailing` }),
		]);

		const error = await rest.getMe().catch((thrown: unknown) => thrown);

		const leaked = [4, 6, 8, TOKEN.length]
			.map((length) => TOKEN.slice(0, length))
			.filter((prefix) => messageOf(error).includes(prefix));
		expect(error).toBeInstanceOf(DiscordAuthError);
		expect(leaked).toEqual([]);
	});

	it("does not include the token in error messages when Discord echoes it", async () => {
		const { rest } = makeClient([json(401, { message: `bad ${TOKEN}` })]);

		const error = await rest.getMe().catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(DiscordAuthError);
		expect(messageOf(error)).not.toContain(TOKEN);
		expect(messageOf(error)).toContain("<redacted>");
	});
});
