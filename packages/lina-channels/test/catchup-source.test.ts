import { describe, expect, it } from "bun:test";
import { DiscordAdapter } from "../src/adapters/discord.ts";
import {
	type CatchupScheduler,
	createCatchupSource,
} from "../src/discord/catchup-source.ts";
import type { DiscordRest } from "../src/discord/rest.ts";
import type { DiscordMessage } from "../src/discord/schemas.ts";
import {
	cursorAt,
	discordMessage,
	fakeRest,
	memoryCursor,
	TEST_CHANNEL,
} from "./discord-rest-fake.ts";

const INTERVAL_MS = 60_000;
const CURSOR_FIVE = cursorAt("5");
const idleScheduler: CatchupScheduler = { interval: () => () => {} };

function connect(
	rest: DiscordRest,
	onMessages: (messages: readonly DiscordMessage[]) => void,
	extra: {
		readonly scheduler?: CatchupScheduler;
		readonly onError?: (error: unknown) => void;
	} = {},
) {
	const adapter = new DiscordAdapter({
		rest,
		channelId: TEST_CHANNEL,
		cursor: memoryCursor("5"),
	});
	return createCatchupSource({
		adapter,
		intervalMs: INTERVAL_MS,
		scheduler: extra.scheduler ?? idleScheduler,
		onMessages,
		onError: extra.onError ?? (() => {}),
	});
}

describe("catch-up source", () => {
	it("does not fetch when paused", async () => {
		const { rest, afterIds } = fakeRest({
			pages: { "5": [discordMessage("6")] },
		});
		const received: string[][] = [];
		const source = connect(rest, (messages) => {
			received.push(messages.map((message) => message.id));
		});

		source.pause();
		source.pause();
		await source.runOnce();

		expect(afterIds).toEqual([]);
		expect(received).toEqual([]);
	});

	it("runs once when the interval fires", async () => {
		const { rest, afterIds } = fakeRest({
			pages: { "5": [discordMessage("6"), discordMessage("7")] },
		});
		const delivered = Promise.withResolvers<readonly string[]>();
		let fire: () => void | Promise<void> = () => {};
		const source = connect(
			rest,
			(messages) => {
				delivered.resolve(messages.map((message) => message.id));
			},
			{
				scheduler: {
					interval: (ms, handler) => {
						expect(ms).toBe(INTERVAL_MS);
						fire = handler;
						return () => {
							fire = () => {};
						};
					},
				},
			},
		);

		source.start();
		await fire();

		expect(await delivered.promise).toEqual(["6", "7"]);
		expect(afterIds).toEqual(["5"]);
		source.stop();
	});

	it("skips the interval tick when the source is paused", async () => {
		const { rest, afterIds } = fakeRest({
			pages: { "5": [discordMessage("6")] },
		});
		let fire: () => void | Promise<void> = () => {};
		const source = connect(
			rest,
			() => {
				throw new Error("paused tick must not emit");
			},
			{
				scheduler: {
					interval: (_ms, handler) => {
						fire = handler;
						return () => {
							fire = () => {};
						};
					},
				},
			},
		);

		source.start();
		source.pause();
		await fire();

		expect(afterIds).toEqual([]);
		source.stop();
	});

	it("does not double-schedule when resume is called twice", async () => {
		const { rest, afterIds } = fakeRest({
			pages: { "5": [discordMessage("9")] },
		});
		const intervals: number[] = [];
		const received: string[][] = [];
		const source = connect(
			rest,
			(messages) => {
				received.push(messages.map((message) => message.id));
			},
			{
				scheduler: {
					interval: (ms, _handler) => {
						intervals.push(ms);
						return () => {};
					},
				},
			},
		);

		source.start();
		source.start();
		source.pause();
		source.resume();
		source.resume();
		await source.runOnce();

		expect(intervals).toEqual([INTERVAL_MS]);
		expect(afterIds).toEqual(["5"]);
		expect(received).toEqual([["9"]]);
		source.stop();
	});

	it("does not advance the cursor when runOnce delivers messages", async () => {
		const { rest } = fakeRest({
			pages: { "5": [discordMessage("6"), discordMessage("7")] },
		});
		const cursor = memoryCursor("5");
		const adapter = new DiscordAdapter({
			rest,
			channelId: TEST_CHANNEL,
			cursor,
		});
		const received: string[] = [];
		const source = createCatchupSource({
			adapter,
			intervalMs: INTERVAL_MS,
			scheduler: idleScheduler,
			onMessages: (messages) => {
				received.push(...messages.map((message) => message.id));
			},
			onError: () => {},
		});

		await source.runOnce();

		expect(received).toEqual(["6", "7"]);
		expect(await cursor.read()).toEqual(CURSOR_FIVE);
	});

	it("reports the tick error when runOnce rejects on the interval", async () => {
		const boom = new Error("rest down");
		let fail = true;
		const { rest } = fakeRest({
			pages: { "5": [discordMessage("6")] },
			shouldFail: () => (fail ? boom : undefined),
		});
		const errors: unknown[] = [];
		const received: string[] = [];
		let fire: () => void | Promise<void> = () => {};
		const source = connect(
			rest,
			(messages) => {
				received.push(...messages.map((message) => message.id));
			},
			{
				onError: (error) => {
					errors.push(error);
				},
				scheduler: {
					interval: (_ms, handler) => {
						fire = handler;
						return () => {
							fire = () => {};
						};
					},
				},
			},
		);

		source.start();
		await fire();
		expect(errors).toEqual([boom]);

		fail = false;
		await source.runOnce();
		expect(received).toEqual(["6"]);
		source.stop();
	});

	it("rejects the caller when runOnce fails", async () => {
		const boom = new Error("rest down");
		const { rest } = fakeRest({
			pages: { "5": [discordMessage("6")] },
			shouldFail: () => boom,
		});
		const source = connect(rest, () => {});

		await expect(source.runOnce()).rejects.toBe(boom);
	});
});
