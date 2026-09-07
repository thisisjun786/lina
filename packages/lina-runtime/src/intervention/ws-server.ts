import { createServer } from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import {
	type AgentRunState,
	assertNever,
	type InboundFrame,
	InboundFrameSchema,
	type OutboundFrame,
} from "./protocol.ts";

/** What the intervention server needs from the host: the steer seam into the agent loop. */
export type InterventionSink = {
	sendUserMessage(
		content: string,
		options?: { readonly deliverAs?: "steer" | "followUp" },
	): unknown;
};

export interface InterventionServer {
	readonly port: number;
	broadcast(frame: OutboundFrame): void;
	stop(): Promise<void>;
}

export type InterventionOptions = {
	readonly port: number;
	readonly sink: InterventionSink;
	/** Read at connect time so a joining client learns whether a turn is already running. */
	readonly currentStatus: () => AgentRunState;
	readonly host?: string;
};

async function handleFrame(
	frame: InboundFrame,
	sink: InterventionSink,
): Promise<OutboundFrame> {
	switch (frame.type) {
		case "chat": {
			const id = frame.id ?? crypto.randomUUID();
			try {
				await sink.sendUserMessage(frame.text, { deliverAs: "steer" });
			} catch (error) {
				return {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				};
			}
			return { type: "ack", id };
		}
		default:
			return assertNever(frame.type);
	}
}

function parseInbound(
	raw: string,
): InboundFrame | { readonly type: "error"; readonly message: string } {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (error) {
		if (error instanceof SyntaxError)
			return { type: "error", message: `invalid json: ${error.message}` };
		throw error;
	}
	const parsed = InboundFrameSchema.safeParse(json);
	return parsed.success
		? parsed.data
		: {
				type: "error",
				message: parsed.error.issues.map((i) => i.message).join("; "),
			};
}

async function onMessage(
	socket: WebSocket,
	raw: string,
	sink: InterventionSink,
): Promise<void> {
	const inbound = parseInbound(raw);
	const reply: OutboundFrame =
		inbound.type === "error" ? inbound : await handleFrame(inbound, sink);
	// The client can disconnect while the sink is still delivering; its reply then has nowhere to go.
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(reply));
}

export async function startInterventionServer(
	options: InterventionOptions,
): Promise<InterventionServer> {
	const httpServer = createServer();
	const wss = new WebSocketServer({ server: httpServer });
	wss.on("connection", (socket) => {
		const snapshot: OutboundFrame = {
			type: "agent-status",
			state: options.currentStatus(),
		};
		socket.send(JSON.stringify(snapshot));
		socket.on("message", (data) => {
			void onMessage(socket, data.toString(), options.sink);
		});
	});
	await new Promise<void>((resolve) =>
		httpServer.listen(options.port, options.host ?? "127.0.0.1", resolve),
	);
	const address = httpServer.address();
	const port =
		typeof address === "object" && address !== null
			? address.port
			: options.port;
	return {
		port,
		broadcast(frame) {
			const text = JSON.stringify(frame);
			for (const client of wss.clients)
				if (client.readyState === client.OPEN) client.send(text);
		},
		async stop() {
			for (const client of wss.clients) client.terminate();
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}
