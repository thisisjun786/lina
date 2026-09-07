import { afterEach, describe, expect, it } from "bun:test";
import {
	type FakeDiscord,
	startFakeDiscord,
} from "../scripts/qa/fake-discord.ts";

const fakes: FakeDiscord[] = [];

function start(): FakeDiscord {
	const fake = startFakeDiscord();
	fakes.push(fake);
	return fake;
}

async function json(response: Response): Promise<unknown> {
	return response.json();
}

function closed(socket: WebSocket): Promise<CloseEvent> {
	return new Promise<CloseEvent>((resolve, reject) => {
		const timeout = AbortSignal.timeout(1_000);
		timeout.addEventListener(
			"abort",
			() => reject(new Error("gateway did not close malformed identify")),
			{ once: true },
		);
		socket.addEventListener("close", resolve, { once: true });
	});
}

afterEach(async () => {
	for (const fake of fakes.splice(0)) await fake.stop();
});

describe("fake Discord boundary", () => {
	it("returns structured 400 when control JSON is malformed", async () => {
		// Given
		const fake = start();
		// When
		const response = await fetch(`${fake.baseUrl}/__control/inject`, {
			method: "POST",
			body: "{",
		});
		// Then
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await json(response)).toEqual({ error: "invalid_json" });
	});

	it("rejects the body when a Discord POST is malformed", async () => {
		// Given
		const fake = start();
		// When
		const response = await fetch(
			`${fake.baseUrl}/api/v10/channels/123/messages`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content: 42 }),
			},
		);
		// Then
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: "invalid_body" });
	});

	it("records every REST request when representative routes are called", async () => {
		// Given
		const fake = start();
		// When
		await fetch(`${fake.baseUrl}/api/v10/users/@me`);
		await fetch(
			`${fake.baseUrl}/api/v10/channels/123/messages?after=1&limit=100`,
		);
		await fetch(
			`${fake.baseUrl}/api/v10/channels/123/messages/1/reactions/%F0%9F%91%80/@me`,
			{ method: "PUT" },
		);
		// Then
		const recorded = fake.events().filter((event) => event.kind === "request");
		expect(
			recorded.map((event) => `${event.request.method} ${event.request.path}`),
		).toEqual([
			"GET /api/v10/users/@me",
			"GET /api/v10/channels/123/messages?after=1&limit=100",
			"PUT /api/v10/channels/123/messages/1/reactions/%F0%9F%91%80/@me",
		]);
	});

	it("rejects extra control fields when the control schema is strict", async () => {
		// Given
		const fake = start();
		// When
		const response = await fetch(`${fake.baseUrl}/__control/inject`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ authorId: "777", content: "x", extra: true }),
		});
		// Then
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: "invalid_body" });
	});

	it("rejects extra Discord POST fields when the message schema is strict", async () => {
		// Given
		const fake = start();
		const body = {
			content: "x",
			nonce: "0123456789abcdef012345678",
			enforce_nonce: true,
			allowed_mentions: { parse: [] },
			message_reference: { message_id: "1" },
			extra: true,
		};
		// When
		const response = await fetch(
			`${fake.baseUrl}/api/v10/channels/123/messages`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		// Then
		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: "invalid_body" });
	});

	it("closes the Gateway when its query differs from the observed discord.js contract", async () => {
		// Given
		const fake = start();
		const socket = new WebSocket(
			`ws://127.0.0.1:${fake.port}/gateway?v=9&encoding=json`,
		);
		// When
		const event = await closed(socket);
		// Then
		expect(event.code).toBe(4002);
		expect(fake.handshake().rejections).toEqual([
			"invalid query: v=9&encoding=json",
		]);
	});

	it("closes the Gateway when IDENTIFY does not match the discord.js contract", async () => {
		// Given
		const fake = start();
		const socket = new WebSocket(
			`ws://127.0.0.1:${fake.port}/gateway?v=10&encoding=json`,
		);
		await new Promise<void>((resolve) =>
			socket.addEventListener("message", () => resolve(), { once: true }),
		);
		// When
		socket.send(
			JSON.stringify({
				op: 2,
				d: { token: "wrong", intents: 0, properties: {} },
			}),
		);
		const event = await closed(socket);
		// Then
		expect(event.code).toBe(4002);
		expect(
			fake
				.events()
				.some((item) => item.kind === "gateway" && item.state === "rejected"),
		).toBe(true);
	});

	it("stops repeatedly when cleanup is called more than once", async () => {
		// Given
		const fake = start();
		// When
		await fake.stop();
		await fake.stop();
		// Then
		await expect(
			fetch(fake.baseUrl, { signal: AbortSignal.timeout(1_000) }),
		).rejects.toThrow();
	});
});
