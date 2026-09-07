import { describe, expect, it } from "bun:test";
import { DiscordAdapter } from "../src/adapters/discord.ts";
import type { DiscordRest } from "../src/discord/rest.ts";
import {
	cursorAt,
	discordMessage,
	fakeRest,
	memoryCursor,
	TEST_CHANNEL,
} from "./discord-rest-fake.ts";

function makeAdapter(rest: DiscordRest, lastSeen?: string) {
	return new DiscordAdapter({
		rest,
		channelId: TEST_CHANNEL,
		cursor: memoryCursor(lastSeen),
	});
}

describe("DiscordAdapter", () => {
	it("writes the newest message id when bootstrapping without a cursor", async () => {
		const { rest, latestCalls } = fakeRest({
			latest: discordMessage("42"),
			pages: {},
		});
		const cursor = memoryCursor();
		const adapter = new DiscordAdapter({
			rest,
			channelId: TEST_CHANNEL,
			cursor,
		});

		await adapter.bootstrap();

		expect(latestCalls()).toBe(1);
		expect(await cursor.read()).toEqual(cursorAt("42"));
	});

	it("writes 0 when the channel is empty at bootstrap", async () => {
		const { rest } = fakeRest({ latest: undefined, pages: {} });
		const cursor = memoryCursor();
		const adapter = new DiscordAdapter({
			rest,
			channelId: TEST_CHANNEL,
			cursor,
		});

		await adapter.bootstrap();

		expect(await cursor.read()).toEqual(cursorAt("0"));
	});

	it("leaves the existing cursor when bootstrapping after a later message exists", async () => {
		const { rest, latestCalls } = fakeRest({
			latest: discordMessage("42"),
			pages: {},
		});
		const cursor = memoryCursor("5");
		const adapter = new DiscordAdapter({
			rest,
			channelId: TEST_CHANNEL,
			cursor,
		});

		await adapter.bootstrap();

		expect(latestCalls()).toBe(0);
		expect(await cursor.read()).toEqual(cursorAt("5"));
	});

	it("follows a full page immediately when 100 messages are returned", async () => {
		const first = Array.from({ length: 100 }, (_, index) =>
			discordMessage(String(105 - index)),
		);
		const { rest, afterIds, limits } = fakeRest({
			pages: { "5": first, "105": [discordMessage("106")] },
		});
		const adapter = makeAdapter(rest, "5");

		const messages = await adapter.poll("2020-01-01T00:00:00.000Z");

		expect(afterIds).toEqual(["5", "105"]);
		expect(limits).toEqual([100, 100]);
		expect(messages.map((message) => `${message.messageId}`)).toHaveLength(101);
		expect(await adapter.cursor.read()).toEqual(cursorAt("5"));
	});

	it("follows another page when a full raw page includes malformed items", async () => {
		const first = Array.from({ length: 99 }, (_, index) =>
			discordMessage(String(104 - index)),
		);
		const { rest, afterIds } = fakeRest({
			pages: { "5": first, "104": [discordMessage("200")] },
			malformedByAfter: { "5": 1 },
		});
		const adapter = makeAdapter(rest, "5");

		const messages = await adapter.pollRaw();

		expect(afterIds).toEqual(["5", "104"]);
		expect(messages.map((message) => message.id)).toEqual([
			...first.map((message) => message.id),
			"200",
		]);
	});

	it("follows another page when the global malformed counter over-counts a full page", async () => {
		const first = Array.from({ length: 100 }, (_, index) =>
			discordMessage(String(105 - index)),
		);
		const { rest, afterIds } = fakeRest({
			pages: { "5": first, "105": [discordMessage("106")] },
			malformedByAfter: { "5": 5 },
		});
		const adapter = makeAdapter(rest, "5");

		const messages = await adapter.pollRaw();

		expect(afterIds).toEqual(["5", "105"]);
		expect(messages).toHaveLength(101);
	});

	it("leaves the cursor unchanged when polling messages", async () => {
		const { rest } = fakeRest({
			pages: { "5": [discordMessage("6"), discordMessage("7")] },
		});
		const adapter = makeAdapter(rest, "5");

		const messages = await adapter.poll(undefined);

		expect(messages.map((message) => `${message.messageId}`)).toEqual([
			"6",
			"7",
		]);
		expect(messages[0]?.text).toBe("m6");
		expect(messages[0]?.authorId).toBe("9");
		expect(messages[0]?.channel).toBe("discord");
		expect(await adapter.cursor.read()).toEqual(cursorAt("5"));
	});

	it("ignores the ISO since argument when polling", async () => {
		const { rest, afterIds } = fakeRest({
			pages: { "5": [discordMessage("8", { replyTo: "4" })] },
		});
		const adapter = makeAdapter(rest, "5");

		const messages = await adapter.poll("2020-01-01T00:00:00.000Z");

		expect(afterIds).toEqual(["5"]);
		expect(afterIds[0]).not.toBe("2020-01-01T00:00:00.000Z");
		expect(`${messages[0]?.replyTo ?? ""}`).toBe("4");
	});

	it("returns no messages when the cursor has not been bootstrapped", async () => {
		const { rest, afterIds, latestCalls } = fakeRest({ pages: {} });
		const adapter = makeAdapter(rest);

		expect(await adapter.pollRaw()).toEqual([]);
		expect(afterIds).toEqual([]);
		expect(latestCalls()).toBe(0);
		expect(await adapter.cursor.read()).toBeUndefined();
	});
});
