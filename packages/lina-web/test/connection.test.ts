import { afterEach, describe, expect, it } from "bun:test";
import { Connection } from "../client/connection.ts";
import { ChatModel } from "../client/model.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0).reverse()) stop();
});

describe("browser connection ownership", () => {
	it("ignores retired frames and never replays when an acknowledgement times out", async () => {
		let received = 0;
		const source = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				return server.upgrade(request) ? undefined : new Response("no");
			},
			websocket: {
				open(socket) {
					socket.send('{"type":"agent-status","state":"idle"}');
				},
				message() {
					received += 1;
				},
			},
		});
		cleanup.push(() => {
			void source.stop(true);
		});
		const timers = new Map<number, () => void>();
		const sockets: WebSocket[] = [];
		const model = new ChatModel();
		const notices: string[] = [];
		let ready = Promise.withResolvers<void>();
		const connection = new Connection(
			`ws://127.0.0.1:${source.port}`,
			{
				frame(frame) {
					model.receive(frame);
					if (frame.type === "agent-status") ready.resolve();
				},
				disconnected() {
					model.disconnect();
				},
				notice(message) {
					notices.push(message);
				},
			},
			{
				createSocket(url) {
					const socket = new WebSocket(url);
					sockets.push(socket);
					return socket;
				},
				schedule(callback, delay) {
					timers.set(delay, callback);
					return () => {
						timers.delete(delay);
					};
				},
			},
		);
		cleanup.push(() => connection.stop());
		connection.connect();
		await ready.promise;
		model.send("first", "request");
		expect(
			connection.send({ type: "chat", id: "first", text: "request" }),
		).toBe(true);
		expect(
			connection.send({ type: "chat", id: "second", text: "request" }),
		).toBe(false);
		const timeout = timers.get(20_000);
		expect(timeout).toBeDefined();
		if (timeout === undefined) throw new Error("Missing send deadline");
		timeout();
		expect(model.messages[0]?.status).toBe("unconfirmed");
		const retired = sockets[0];
		ready = Promise.withResolvers<void>();
		connection.connect();
		await ready.promise;
		retired?.dispatchEvent(
			new MessageEvent("message", {
				data: '{"type":"error","message":"late"}',
			}),
		);
		retired?.dispatchEvent(
			new MessageEvent("message", { data: '{"type":"ack","id":"first"}' }),
		);
		expect(model.connected).toBe(true);
		expect(model.messages[0]?.status).toBe("unconfirmed");
		expect(model.messages).toHaveLength(1);
		expect(notices).toHaveLength(1);
		expect(received).toBe(1);
		connection.stop();
		expect(timers.size).toBe(0);
		ready = Promise.withResolvers<void>();
		connection.resume();
		await ready.promise;
		expect(sockets).toHaveLength(3);
		expect(model.messages[0]?.status).toBe("unconfirmed");
		expect(received).toBe(1);
	});
});

describe("durable connection heartbeat", () => {
	it("requires a matching pong; traffic cannot mask a dead controller or replay a chat", async () => {
		const timers = new Map<number, () => void>(),
			sockets: WebSocket[] = [],
			notices: string[] = [];
		let connected = false;
		const ready = Promise.withResolvers<void>();
		let received = Promise.withResolvers<Record<string, unknown>>();
		const source = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(req, server) {
				return server.upgrade(req) ? undefined : new Response("no");
			},
			websocket: {
				open(socket) {
					socket.send(
						JSON.stringify({
							type: "snapshot",
							snapshot: {
								version: 2,
								botId: "lina",
								sessionId: "fixed",
								revision: 0,
								state: "running",
								messages: [],
								requests: [],
								hasEarlier: false,
								beforeCursor: null,
							},
						}),
					);
				},
				message(_socket, raw) {
					received.resolve(JSON.parse(String(raw)));
				},
			},
		});
		const c = new Connection(
			`ws://127.0.0.1:${source.port}`,
			{
				frame(f) {
					if (f.type === "snapshot") {
						connected = true;
						ready.resolve();
					}
				},
				disconnected() {
					connected = false;
				},
				notice(m) {
					notices.push(m);
				},
			},
			{
				createSocket(url) {
					const s = new WebSocket(url);
					sockets.push(s);
					return s;
				},
				schedule(fn, delay) {
					timers.set(delay, fn);
					return () => {
						timers.delete(delay);
					};
				},
			},
		);
		cleanup.push(() => {
			c.stop();
			void source.stop(true);
		});
		c.connect();
		await ready.promise;
		const fire = (delay: number) => {
			const fn = timers.get(delay);
			expect(fn).toBeDefined();
			if (!fn) throw Error(`No timer ${delay}`);
			timers.delete(delay);
			fn();
		};
		const deliver = (frame: unknown) =>
			sockets[0]?.dispatchEvent(
				new MessageEvent("message", { data: JSON.stringify(frame) }),
			);
		fire(15000);
		const ping = await received.promise;
		expect(ping).toMatchObject({ type: "ping", sessionId: "fixed" });
		expect(typeof ping["nonce"]).toBe("string");
		deliver({ type: "pong", sessionId: "other", nonce: ping["nonce"] });
		expect(timers.has(8000)).toBe(true);
		deliver({ type: "pong", sessionId: "fixed", nonce: "wrong" });
		expect(timers.has(8000)).toBe(true);
		deliver({ type: "pong", sessionId: "fixed", nonce: ping["nonce"] });
		expect(timers.has(8000)).toBe(false);
		expect(timers.has(15000)).toBe(true);
		received = Promise.withResolvers();
		expect(
			c.send({ type: "chat", id: "once", sessionId: "fixed", text: "hello" }),
		).toBe(true);
		await received.promise;
		received = Promise.withResolvers();
		fire(15000);
		const next = await received.promise;
		deliver({ type: "pong", sessionId: "fixed", nonce: ping["nonce"] });
		expect(timers.has(20000)).toBe(true);
		expect(timers.has(8000)).toBe(true);
		fire(8000);
		expect(connected).toBe(false);
		expect(notices).toHaveLength(1);
		deliver({ type: "pong", sessionId: "fixed", nonce: next["nonce"] });
		expect(connected).toBe(false);
		expect(timers.has(15000)).toBe(false);
		c.stop();
		expect(timers.size).toBe(0);
	});
});
