import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CursorCorruptError,
	CursorStore,
} from "../src/discord/cursor-store.ts";

describe("CursorStore", () => {
	let directory = "";
	let path = "";
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "lina-cursor-"));
		path = join(directory, "cursor.json");
	});
	afterEach(async () => {
		await rm(directory, { recursive: true, force: true });
	});

	it("returns undefined when no file exists", async () => {
		const store = new CursorStore(path, "123");
		expect(await store.read()).toBeUndefined();
	});

	it("requires a channel id when constructing the store", () => {
		expect(() => Reflect.construct(CursorStore, [path])).toThrow(TypeError);
	});

	it("rejects a cursor that fails the schema when write is called", async () => {
		const store = new CursorStore(path, "123");
		const invalid = JSON.parse(
			'{"version":2,"channelId":"123","lastSeenMessageId":"10"}',
		);
		await expect(store.write(invalid)).rejects.toBeInstanceOf(Error);
		expect(await Bun.file(path).exists()).toBe(false);
		expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
	});

	it("round-trips the 0 bootstrap sentinel when writing and reading", async () => {
		const store = new CursorStore(path, "123");
		await store.write({ version: 1, channelId: "123", lastSeenMessageId: "0" });
		expect(await store.read()).toEqual({
			version: 1,
			channelId: "123",
			lastSeenMessageId: "0",
		});
	});

	it("round-trips a cursor when written then read", async () => {
		const store = new CursorStore(path, "123");
		const cursor = {
			version: 1 as const,
			channelId: "123",
			lastSeenMessageId: "10",
		};
		await store.write(cursor);
		expect(await store.read()).toEqual(cursor);
	});

	it("does not move backwards when advance is called with a smaller snowflake", async () => {
		const store = new CursorStore(path, "123");
		await store.write({
			version: 1,
			channelId: "123",
			lastSeenMessageId: "10",
		});
		expect(await store.advance("9")).toBe(false);
		expect(await store.read()).toEqual({
			version: 1,
			channelId: "123",
			lastSeenMessageId: "10",
		});
	});

	it("reports CursorCorruptError when the file holds another channelId", async () => {
		const store = new CursorStore(path, "123");
		await Bun.write(
			path,
			JSON.stringify({ version: 1, channelId: "456", lastSeenMessageId: "10" }),
		);
		await expect(store.read()).rejects.toBeInstanceOf(CursorCorruptError);
	});

	it("leaves no .tmp file behind when writing a cursor", async () => {
		const store = new CursorStore(path, "123");
		await store.write({
			version: 1,
			channelId: "123",
			lastSeenMessageId: "10",
		});
		expect(await Bun.file(`${path}.tmp`).exists()).toBe(false);
	});
});
