import { afterEach, describe, expect, it } from "bun:test";
import WebSocket, { WebSocketServer } from "ws";
import { z } from "zod";
import type { ConnectionState } from "../src/bridge/intervention-client.ts";
import {
	AgentErrorFrameError,
	createInterventionClient,
	InFlightError,
	type InterventionClient,
	NotConnectedError,
	SocketClosedError,
} from "../src/bridge/intervention-client.ts";

/** What the agent side must receive: a chat frame that always carries a non-empty id. */
const ChatFrameSchema = z.object({
	type: z.literal("chat"),
	id: z.string().min(1),
	text: z.string(),
});
type ChatRecord = z.infer<typeof ChatFrameSchema>;
type ScheduledDelay = { readonly ms: number; readonly handler: () => void };

/** Awaitable FIFO: tests await the next item instead of polling or sleeping. */
function createQueue<T>() {
	const items: T[] = [];
	const waiters: ((item: T) => void)[] = [];
	return {
		size: (): number => items.length,
		push(item: T): void {
			const waiter = waiters.shift();
			if (waiter === undefined) items.push(item);
			else waiter(item);
		},
		next(): Promise<T> {
			const item = items.shift();
			if (item !== undefined) return Promise.resolve(item);
			return new Promise<T>((resolve) => {
				waiters.push(resolve);
			});
		},
	};
}

type TestServer = {
	readonly port: number;
	nextSocket(): Promise<WebSocket>;
	nextChat(): Promise<ChatRecord>;
	queuedChats(): number;
	stop(): Promise<void>;
};

/** A real ws server that mirrors lina-runtime: the connect-time status snapshot comes first. */
async function startTestServer(): Promise<TestServer> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	const sockets = createQueue<WebSocket>();
	const chats = createQueue<ChatRecord>();
	server.on("connection", (socket) => {
		socket.on("message", (data) => {
			chats.push(ChatFrameSchema.parse(JSON.parse(data.toString())));
		});
		socket.send(JSON.stringify({ type: "agent-status", state: "idle" }));
		sockets.push(socket);
	});
	await new Promise<void>((resolve) =>
		server.once("listening", () => resolve()),
	);
	const address = server.address();
	return {
		port: typeof address === "object" && address !== null ? address.port : 0,
		nextSocket: () => sockets.next(),
		nextChat: () => chats.next(),
		queuedChats: () => chats.size(),
		async stop() {
			for (const socket of server.clients) socket.terminate();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

type Harness = {
	readonly client: InterventionClient;
	readonly logs: string[];
	readonly delays: ScheduledDelay[];
	readonly states: ReturnType<typeof createQueue<ConnectionState>>;
	readonly events: ReturnType<typeof createQueue<string>>;
};

function makeHarness(port: number): Harness {
	const logs: string[] = [];
	const delays: ScheduledDelay[] = [];
	const states = createQueue<ConnectionState>();
	const events = createQueue<string>();
	const client = createInterventionClient({
		url: `ws://127.0.0.1:${port}`,
		wsFactory: (url) => new WebSocket(url),
		scheduler: {
			delay: (ms, handler) => {
				const task = { ms, handler };
				delays.push(task);
				return () => {
					const at = delays.indexOf(task);
					if (at >= 0) delays.splice(at, 1);
				};
			},
		},
		log: (message) => logs.push(message),
	});
	client.onConnectionChange((state) => states.push(state));
	client.onStatus((state) => events.push(`status:${state}`));
	client.onText((text) => events.push(`text:${text}`));
	return { client, logs, delays, states, events };
}

/** Fails loudly instead of hanging when the client scheduled no reconnect. */
function takeDelay(delays: ScheduledDelay[]): ScheduledDelay {
	const task = delays.shift();
	if (task === undefined) throw new Error("no reconnect was scheduled");
	return task;
}

describe("intervention client", () => {
	let server: TestServer | undefined;
	let client: InterventionClient | undefined;

	afterEach(async () => {
		client?.close();
		client = undefined;
		await server?.stop();
		server = undefined;
	});

	async function openPair(): Promise<{
		readonly harness: Harness;
		readonly socket: WebSocket;
		readonly testServer: TestServer;
	}> {
		const testServer = await startTestServer();
		server = testServer;
		const harness = makeHarness(testServer.port);
		client = harness.client;
		harness.client.connect();
		expect(await harness.states.next()).toBe("connected");
		return { harness, socket: await testServer.nextSocket(), testServer };
	}

	it("resolves send when the ack echoes the id", async () => {
		const { harness, socket, testServer } = await openPair();
		const ack = harness.client.send({ type: "chat", id: "m1", text: "hi" });
		const chat = await testServer.nextChat();
		socket.send(JSON.stringify({ type: "ack", id: chat.id }));
		expect(await ack).toEqual({ id: "m1" });
		expect(chat).toEqual({ type: "chat", id: "m1", text: "hi" });
	});

	it("rejects send when an error frame arrives", async () => {
		const { harness, socket, testServer } = await openPair();
		const ack = harness.client.send({ type: "chat", id: "m2", text: "boom" });
		await testServer.nextChat();
		socket.send(JSON.stringify({ type: "error", message: "host is busy" }));
		await expect(ack).rejects.toBeInstanceOf(AgentErrorFrameError);
		await expect(ack).rejects.toThrow("host is busy");
	});

	it("rejects the second send when one is already in flight", async () => {
		const { harness, socket, testServer } = await openPair();
		const first = harness.client.send({ type: "chat", id: "m3", text: "one" });
		await testServer.nextChat();
		const second = harness.client.send({ type: "chat", id: "m4", text: "two" });
		await expect(second).rejects.toBeInstanceOf(InFlightError);
		socket.send(JSON.stringify({ type: "ack", id: "m3" }));
		expect(await first).toEqual({ id: "m3" });
		expect(testServer.queuedChats()).toBe(0);
	});

	it("emits status then text in arrival order when the agent broadcasts both", async () => {
		const { harness, socket } = await openPair();
		expect(await harness.events.next()).toBe("status:idle");
		socket.send(JSON.stringify({ type: "agent-status", state: "running" }));
		socket.send(JSON.stringify({ type: "agent-text", text: "hello" }));
		expect(await harness.events.next()).toBe("status:running");
		expect(await harness.events.next()).toBe("text:hello");
	});

	it("reconnects with the first backoff step when the server closes", async () => {
		const { harness, socket, testServer } = await openPair();
		socket.close();
		expect(await harness.states.next()).toBe("disconnected");
		const retry = takeDelay(harness.delays);
		expect(retry.ms).toBe(250);
		retry.handler();
		expect(await harness.states.next()).toBe("connected");
		expect(await testServer.nextSocket()).toBeDefined();
	});

	it("restarts the backoff ladder at the first step when a reconnect succeeded", async () => {
		const { harness, socket, testServer } = await openPair();
		socket.close();
		expect(await harness.states.next()).toBe("disconnected");
		takeDelay(harness.delays).handler();
		expect(await harness.states.next()).toBe("connected");
		(await testServer.nextSocket()).close();
		expect(await harness.states.next()).toBe("disconnected");
		expect(takeDelay(harness.delays).ms).toBe(250);
	});

	it("rejects the pending send when the socket closes mid-flight", async () => {
		const { harness, socket, testServer } = await openPair();
		const ack = harness.client.send({ type: "chat", id: "m6", text: "hi" });
		await testServer.nextChat();
		socket.close();
		await expect(ack).rejects.toBeInstanceOf(SocketClosedError);
	});

	it("ignores noise and a decoy ack when the matching ack still arrives", async () => {
		const { harness, socket, testServer } = await openPair();
		const ack = harness.client.send({ type: "chat", id: "m8", text: "hi" });
		await testServer.nextChat();
		socket.send("not json at all");
		socket.send(JSON.stringify({ type: "banana", text: "unknown" }));
		socket.send(JSON.stringify({ type: "ack", id: "decoy" }));
		socket.send(JSON.stringify({ type: "ack", id: "m8" }));
		expect(await ack).toEqual({ id: "m8" });
		expect(harness.logs).toHaveLength(3);
	});

	it("rejects send with NotConnectedError when the client never connected", async () => {
		const testServer = await startTestServer();
		server = testServer;
		const harness = makeHarness(testServer.port);
		client = harness.client;
		const ack = harness.client.send({ type: "chat", id: "m9", text: "hi" });
		await expect(ack).rejects.toBeInstanceOf(NotConnectedError);
	});
});
