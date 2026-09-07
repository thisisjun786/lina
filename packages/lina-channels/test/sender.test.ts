import { describe, expect, it } from "bun:test";
import {
	createDiscordSender,
	splitDiscordContent,
} from "../src/discord/sender.ts";

type Payload = {
	readonly content: string;
	readonly nonce: string;
	readonly message_reference?: { readonly message_id: string } | undefined;
};
function fakeRest(options: { readonly failDelete?: boolean } = {}) {
	const posts: Payload[] = [];
	const events: string[] = [];
	return {
		posts,
		events,
		createMessage: async (_channel: string, payload: Payload) => {
			events.push(`start${posts.length + 1}`);
			await Promise.resolve();
			posts.push(payload);
			events.push(`end${posts.length}`);
			return { id: `${posts.length}` };
		},
		deleteOwnReaction: async (
			_channel: string,
			message: string,
			emoji: string,
		) => {
			events.push(`delete:${message}:${emoji}`);
			if (options.failDelete) throw new Error("delete failed");
		},
		addReaction: async (_channel: string, message: string, emoji: string) => {
			events.push(`add:${message}:${emoji}`);
		},
	};
}

const send = (
	rest: ReturnType<typeof fakeRest>,
	text: string,
	log = () => {},
) =>
	createDiscordSender({ rest, channelId: "c", log }).sendReply({
		replyToMessageId: "origin",
		text,
	});

describe("discord sender", () => {
	it("returns no ids and issues no requests when the reply text is only whitespace", async () => {
		const rest = fakeRest();
		const result = await send(rest, " \n\t");
		expect(result).toEqual({ messageIds: [] });
		expect(rest.posts).toEqual([]);
		expect(rest.events).toEqual([]);
	});
	it("drops the delimiter when the text opens with a paragraph break", () => {
		expect(splitDiscordContent("\n\nhello")).toEqual(["hello"]);
	});
	it("cuts at the last paragraph boundary when the text exceeds the chunk limit", () => {
		const chunks = splitDiscordContent(
			`${"a".repeat(1998)}\n\n\n\n${"b".repeat(2501)}`,
		);
		expect(chunks.map((chunk) => chunk.length)).toEqual([1998, 2000, 501]);
		expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
		expect(chunks).not.toContain("");
	});
	it("keeps a surrogate pair whole when the chunk limit falls between its halves", () => {
		const chunks = splitDiscordContent(
			`${"a".repeat(1999)}\u{1f600}${"b".repeat(2000)}`,
		);
		expect(chunks.map((chunk) => chunk.length)).toEqual([1999, 2000, 2]);
		expect(chunks[1]?.startsWith("\u{1f600}")).toBe(true);
		expect(
			chunks.every(
				(chunk) =>
					new TextDecoder().decode(new TextEncoder().encode(chunk)) === chunk,
			),
		).toBe(true);
	});
	it("derives a distinct 25-hex nonce per chunk when the reply spans three chunks", async () => {
		const rest = fakeRest();
		const result = await send(rest, "x".repeat(4500));
		expect(result.messageIds).toEqual(["1", "2", "3"]);
		expect(new Set(rest.posts.map((post) => post.nonce)).size).toBe(3);
		for (const [index, post] of rest.posts.entries()) {
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(`origin\n${index}\n${post.content}`),
			);
			const expected = [...new Uint8Array(digest)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("")
				.slice(0, 25);
			expect(post.nonce).toBe(expected);
			expect(post.nonce).toMatch(/^[0-9a-f]{25}$/);
		}
	});
	it("sequences posts then swaps the origin reaction when the reply needs two chunks", async () => {
		const rest = fakeRest();
		const result = await send(rest, "x".repeat(2001));
		expect(rest.events).toEqual([
			"start1",
			"end1",
			"start2",
			"end2",
			"delete:origin:👀",
			"add:origin:👍",
		]);
		expect(
			rest.posts.every(
				(post) => post.message_reference?.message_id === "origin",
			),
		).toBe(true);
		expect(result.messageIds).toEqual(["1", "2"]);
	});
	it("posts every later chunk when the split yields a whitespace-only chunk", async () => {
		const rest = fakeRest();
		const result = await send(
			rest,
			`${"a".repeat(1998)}\n\n \t\n\n${"b".repeat(2500)}`,
		);
		expect(rest.posts.map((post) => post.content.length)).toEqual([
			1998, 2000, 500,
		]);
		expect(rest.posts.every((post) => post.content.trim().length > 0)).toBe(
			true,
		);
		expect(result.messageIds).toEqual(["1", "2", "3"]);
	});
	it("still adds the thumbs-up and logs once when deleting the eyes reaction fails", async () => {
		const rest = fakeRest({ failDelete: true });
		const logs: unknown[] = [];
		await send(rest, "hello", (...args: readonly unknown[]) => logs.push(args));
		expect(rest.events).toEqual([
			"start1",
			"end1",
			"delete:origin:👀",
			"add:origin:👍",
		]);
		expect(logs).toHaveLength(1);
	});
	it("returns one ordered id when the reply fits in a single chunk", async () => {
		const rest = fakeRest();
		const sender = createDiscordSender({ rest, channelId: "c", log: () => {} });
		expect(
			await sender.sendReply({ replyToMessageId: "origin", text: "hello" }),
		).toEqual({ messageIds: ["1"] });
	});
});
