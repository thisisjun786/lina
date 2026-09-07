import { afterEach, describe, expect, it } from "bun:test";
import { startInterventionServer } from "../../lina-runtime/src/intervention/ws-server.ts";
import { startWebServer } from "../src/server.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});
const assets = {
	themeScript: "document.documentElement.dataset.theme = 'dark';",
	icon: "<svg></svg>",
	html: "<title>Lina</title>",
	script: "export {};",
	css: "body{}",
};

it("explicit container binding preserves host and origin checks", async () => {
	const server = startWebServer({
		port: 0,
		hostname: "0.0.0.0",
		upstream: "ws://127.0.0.1:1",
		assets,
	});
	cleanup.push(async () => server.stop(true));
	expect(server.hostname).toBe("0.0.0.0");
	const result = await fetch(`http://127.0.0.1:${server.port}/`, {
		headers: { Host: "untrusted.invalid" },
	});
	expect(result.status).toBe(403);
});

async function fixture(publicOrigin?: string) {
	const sent: string[] = [];
	const upstream = await startInterventionServer({
		port: 0,
		currentStatus: () => "idle",
		sink: {
			sendUserMessage(text) {
				sent.push(text);
			},
		},
	});
	cleanup.push(() => upstream.stop());
	const server = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets,
		...(publicOrigin === undefined ? {} : { publicOrigin }),
	});
	cleanup.push(async () => server.stop(true));
	const url = `http://127.0.0.1:${server.port}`;
	return { sent, upstream, server, url };
}

function client(url: string, origin = url, host?: string) {
	const socket = new WebSocket(`${url.replace("http", "ws")}/ws`, {
		headers: { Origin: origin, ...(host === undefined ? {} : { Host: host }) },
	});
	const queue: unknown[] = [];
	const waiters: ((value: unknown) => void)[] = [];
	socket.addEventListener("message", (event) => {
		const value: unknown = JSON.parse(String(event.data));
		const waiter = waiters.shift();
		if (waiter === undefined) queue.push(value);
		else waiter(value);
	});
	cleanup.push(async () => {
		socket.close();
	});
	return {
		socket,
		next: () =>
			queue.length > 0
				? Promise.resolve(queue.shift())
				: new Promise<unknown>((resolve) => waiters.push(resolve)),
	};
}

describe("local web gateway", () => {
	for (const command of [
		{ type: "job-cancel", sessionId: "session", jobId: "job" },
		{ type: "job-output", sessionId: "session", jobId: "job", offset: 0 },
		{
			type: "job-approval",
			sessionId: "session",
			jobId: "job",
			approvalId: "approval",
			inputDigest: "a".repeat(64),
			decision: "allow",
		},
	]) {
		it(`rejects retired ${command.type} before it reaches upstream`, async () => {
			const forwarded: unknown[] = [];
			const upstream = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request, server) {
					if (server.upgrade(request)) return;
					return new Response("WebSocket required", { status: 400 });
				},
				websocket: {
					open(socket) {
						socket.send(
							JSON.stringify({ type: "agent-status", state: "idle" }),
						);
					},
					message(socket, raw) {
						forwarded.push(JSON.parse(String(raw)));
						socket.send(
							JSON.stringify({ type: "ack", id: "retired-forwarded" }),
						);
					},
				},
			});
			cleanup.push(async () => upstream.stop(true));
			const server = startWebServer({
				port: 0,
				upstream: `ws://127.0.0.1:${upstream.port}`,
				assets,
			});
			cleanup.push(async () => server.stop(true));
			const peer = client(`http://127.0.0.1:${server.port}`);
			await peer.next();
			const closed = new Promise<number>((resolve) =>
				peer.socket.addEventListener("close", (event) => resolve(event.code), {
					once: true,
				}),
			);
			peer.socket.send(JSON.stringify(command));
			expect(await peer.next()).toEqual({
				type: "error",
				message: "Invalid chat frame",
			});
			expect(await closed).toBe(1008);
			expect(forwarded).toEqual([]);
		});
	}
	it("serves the early theme bootstrap under the existing script policy", async () => {
		const { url } = await fixture();
		const response = await fetch(`${url}/theme.js`);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(assets.themeScript);
		expect(response.headers.get("content-security-policy")).toContain(
			"script-src 'self'",
		);
	});
	it("does not expose reference portraits when the UI uses a symbol identity", async () => {
		const { url } = await fixture();
		for (const path of ["/lina-profile-v5.png", "/lina-app-icon-v1.png"]) {
			expect((await fetch(`${url}${path}`)).status).toBe(404);
		}
	});
	it("serves the UI when ChatGPT forwards localhost on a different port", async () => {
		const { url } = await fixture();
		expect(
			(await fetch(url, { headers: { Host: "localhost:60875" } })).status,
		).toBe(200);
		const peer = client(url, "http://localhost:60875", "localhost:60875");
		expect(await peer.next()).toEqual({ type: "agent-status", state: "idle" });
	});
	it("passes HTTPS-origin WebSockets when an explicitly configured proxy connects", async () => {
		const origin = "https://lina.example.test:7980";
		const { url } = await fixture(origin);
		expect(
			(await fetch(url, { headers: { Host: "lina.example.test:7980" } }))
				.status,
		).toBe(200);
		for (const host of ["lina.example.test:7980", new URL(url).host]) {
			const peer = client(url, origin, host);
			expect(await peer.next()).toEqual({
				type: "agent-status",
				state: "idle",
			});
		}
	});
	it("ignores forwarding headers when an unconfigured caller spoofs the public host", async () => {
		const { url } = await fixture();
		expect(
			(
				await fetch(url, {
					headers: {
						Host: "evil.example",
						"X-Forwarded-Host": "localhost:7980",
						"X-Forwarded-Proto": "https",
					},
				})
			).status,
		).toBe(403);
	});
	it("forwards real intervention frames when a same-origin client sends chat", async () => {
		const { url, sent, upstream } = await fixture();
		const peer = client(url);
		expect(await peer.next()).toEqual({ type: "agent-status", state: "idle" });
		peer.socket.send(
			JSON.stringify({ type: "chat", id: "browser-1", text: "안녕" }),
		);
		expect(await peer.next()).toEqual({ type: "ack", id: "browser-1" });
		expect(sent).toEqual(["안녕"]);
		upstream.broadcast({ type: "agent-text", text: "테스트 응답" });
		expect(await peer.next()).toEqual({
			type: "agent-text",
			text: "테스트 응답",
		});
	});
	it("rejects cross-origin upgrades when Origin is absent, null, foreign or another port", async () => {
		const { url } = await fixture();
		for (const origin of [
			undefined,
			"null",
			"https://example.com",
			"http://127.0.0.1:1",
		]) {
			const headers = new Headers({
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			});
			if (origin !== undefined) headers.set("Origin", origin);
			expect((await fetch(`${url}/ws`, { headers })).status).toBe(403);
		}
	});
	it("serves only fixed assets when paths and hostnames are requested", async () => {
		const { url } = await fixture();
		const root = await fetch(url);
		expect(await root.text()).toContain("<title>Lina</title>");
		expect(root.headers.get("Content-Security-Policy")).toContain(
			"frame-ancestors 'none'",
		);
		expect((await fetch(`${url}/.env`)).status).toBe(404);
		expect(
			(await fetch(url, { headers: { Host: "evil.example" } })).status,
		).toBe(403);
	});
	it("does not send malformed input upstream when a client bypasses the form", async () => {
		const { url, sent } = await fixture();
		const peer = client(url);
		await peer.next();
		peer.socket.send('{"type":"chat","id":"x","text":"","extra":true}');
		expect(await peer.next()).toMatchObject({ type: "error" });
		expect(sent).toHaveLength(0);
	});
	it("closes the browser connection when the upstream goes away", async () => {
		const { url, upstream } = await fixture();
		const peer = client(url);
		await peer.next();
		const closed = new Promise<void>((resolve) =>
			peer.socket.addEventListener("close", () => resolve(), { once: true }),
		);
		await upstream.stop();
		await closed;
		expect(peer.socket.readyState).toBe(WebSocket.CLOSED);
		cleanup.splice(0, 1);
	});
});
