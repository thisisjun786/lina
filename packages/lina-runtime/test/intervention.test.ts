import { afterEach, describe, expect, it } from "bun:test";
import WebSocket from "ws";
import { z } from "zod";
import {
	type InterventionServer,
	startInterventionServer,
} from "../src/intervention/ws-server.ts";

/** The ack contract a bridge client relies on: always a non-empty correlation id. */
const AckSchema = z.object({ type: z.literal("ack"), id: z.string().min(1) });

type SentMessage = {
	readonly content: string;
	readonly deliverAs: "steer" | "followUp" | undefined;
};

function makeSink() {
	const sent: SentMessage[] = [];
	return {
		sent,
		sink: {
			sendUserMessage(
				content: string,
				options?: { deliverAs?: "steer" | "followUp" },
			): void {
				sent.push({ content, deliverAs: options?.deliverAs });
			},
		},
	};
}

type FrameClient = {
	readonly ws: WebSocket;
	/** Resolves with the oldest frame not yet consumed, waiting for the next one when the queue is empty. */
	nextFrame(): Promise<unknown>;
	queuedFrames(): number;
};

/** Queues frames from socket construction on, so a frame sent at connect time cannot race a late listener. */
async function openClient(port: number): Promise<FrameClient> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const queue: unknown[] = [];
	const waiting: ((frame: unknown) => void)[] = [];
	ws.on("message", (data) => {
		const frame: unknown = JSON.parse(data.toString());
		const waiter = waiting.shift();
		if (waiter === undefined) queue.push(frame);
		else waiter(frame);
	});
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	return {
		ws,
		nextFrame() {
			if (queue.length > 0) return Promise.resolve(queue.shift());
			return new Promise<unknown>((resolve) => {
				waiting.push(resolve);
			});
		},
		queuedFrames: () => queue.length,
	};
}

function isStatusFrame(frame: unknown): boolean {
	return (
		typeof frame === "object" &&
		frame !== null &&
		"type" in frame &&
		frame.type === "agent-status"
	);
}

/** The next frame that answers a client message, skipping the connect-time status snapshot. */
async function nextReply(client: FrameClient): Promise<unknown> {
	let frame = await client.nextFrame();
	while (isStatusFrame(frame)) frame = await client.nextFrame();
	return frame;
}

describe("intervention ws server", () => {
	let server: InterventionServer | undefined;
	afterEach(async () => {
		await server?.stop();
		server = undefined;
	});

	it("forwards a chat frame to sendUserMessage as steer when the payload is well-formed", async () => {
		const { sent, sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		client.ws.send(JSON.stringify({ type: "chat", text: "hi" }));
		const ack = await nextReply(client);
		expect(ack).toMatchObject({ type: "ack" });
		expect(sent).toEqual([{ content: "hi", deliverAs: "steer" }]);
		client.ws.close();
	});

	it("acks with a generated id when the chat frame carries none", async () => {
		const { sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		client.ws.send(JSON.stringify({ type: "chat", text: "hi" }));
		const ack = AckSchema.safeParse(await nextReply(client));
		expect(ack.success).toBe(true);
		client.ws.close();
	});

	it("acks with the same id when the chat frame carries one", async () => {
		const { sent, sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		client.ws.send(
			JSON.stringify({ type: "chat", id: "msg-42", text: "hello lina" }),
		);
		expect(await nextReply(client)).toEqual({ type: "ack", id: "msg-42" });
		expect(sent).toEqual([{ content: "hello lina", deliverAs: "steer" }]);
		client.ws.close();
	});

	it("acks only after sendUserMessage resolved when the sink is async", async () => {
		const delivered: string[] = [];
		const entered = Promise.withResolvers<void>();
		const delivery = Promise.withResolvers<void>();
		const sink = {
			sendUserMessage(content: string): Promise<void> {
				delivered.push(content);
				entered.resolve();
				return delivery.promise;
			},
		};
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "running",
		});
		const client = await openClient(server.port);
		expect(await client.nextFrame()).toEqual({
			type: "agent-status",
			state: "running",
		});
		client.ws.send(
			JSON.stringify({ type: "chat", id: "slow-1", text: "wait" }),
		);
		await entered.promise;
		expect(client.queuedFrames()).toBe(0);
		// A malformed frame is answered synchronously: it must overtake the still-pending ack.
		client.ws.send(JSON.stringify({ type: "chat", text: 42 }));
		expect(await nextReply(client)).toMatchObject({ type: "error" });
		expect(delivered).toEqual(["wait"]);
		delivery.resolve();
		expect(await nextReply(client)).toEqual({ type: "ack", id: "slow-1" });
		client.ws.close();
	});

	it("sends the current agent-status as the first frame when a client connects", async () => {
		const { sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "running",
		});
		const client = await openClient(server.port);
		expect(await client.nextFrame()).toEqual({
			type: "agent-status",
			state: "running",
		});
		client.ws.close();
	});

	it("answers an error frame and does not forward when the payload is malformed", async () => {
		const { sent, sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		client.ws.send(JSON.stringify({ type: "chat", text: 42 }));
		expect(await nextReply(client)).toMatchObject({ type: "error" });
		expect(sent).toEqual([]);
		client.ws.close();
	});

	it("answers an error frame when the sink throws while delivering the chat", async () => {
		const sink = {
			sendUserMessage(): void {
				throw new Error("host is busy");
			},
		};
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		client.ws.send(JSON.stringify({ type: "chat", id: "boom", text: "hi" }));
		expect(await nextReply(client)).toEqual({
			type: "error",
			message: "host is busy",
		});
		client.ws.close();
	});

	it("broadcasts agent activity frames when every viewer is connected", async () => {
		const { sink } = makeSink();
		server = await startInterventionServer({
			port: 0,
			sink,
			currentStatus: () => "idle",
		});
		const client = await openClient(server.port);
		const frame = nextReply(client);
		server.broadcast({ type: "agent-text", text: "thinking out loud" });
		expect(await frame).toMatchObject({
			type: "agent-text",
			text: "thinking out loud",
		});
		client.ws.close();
	});
});
