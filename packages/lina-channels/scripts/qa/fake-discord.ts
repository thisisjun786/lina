import {
	createGatewayRecorder,
	type GatewayData,
	type GatewayRecorder,
} from "./fake-discord-gateway.ts";
import { createFakeDiscordRest } from "./fake-discord-rest.ts";
import type {
	FakeDiscordEvent,
	HandshakeSnapshot,
	StoredMessage,
} from "./fake-discord-types.ts";

export type { FakeDiscordEvent } from "./fake-discord-types.ts";
export type FakeDiscord = {
	readonly port: number;
	readonly baseUrl: string;
	onEvent(listener: (event: FakeDiscordEvent) => void): () => void;
	events(): readonly FakeDiscordEvent[];
	handshake(): HandshakeSnapshot;
	disconnectGateway(): void;
	stop(): Promise<void>;
};

function assertNever(value: never): never {
	throw new Error(`unexpected fake Gateway result: ${JSON.stringify(value)}`);
}

export function startFakeDiscord(): FakeDiscord {
	const events: FakeDiscordEvent[] = [];
	const listeners = new Set<(event: FakeDiscordEvent) => void>();
	const sockets = new Set<Bun.ServerWebSocket<GatewayData>>();
	let sequence = 0;
	let boundPort: number | undefined;
	let stopped = false;
	const emit = (event: FakeDiscordEvent): void => {
		events.push(event);
		for (const listener of listeners) listener(event);
	};
	const dispatch = (message: StoredMessage): void => {
		const frame = JSON.stringify({
			op: 0,
			t: "MESSAGE_CREATE",
			s: ++sequence,
			d: message,
		});
		for (const socket of sockets) socket.send(frame);
	};
	const gateway: GatewayRecorder = createGatewayRecorder({
		emit,
		port: () => boundPort,
		nextSequence: () => ++sequence,
	});
	const rest = createFakeDiscordRest({ emit, dispatch });
	const server = Bun.serve<GatewayData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, serving) {
			const url = new URL(request.url);
			if (url.pathname === "/gateway") {
				return serving.upgrade(request, { data: { requestUrl: request.url } })
					? undefined
					: Response.json({ error: "upgrade_failed" }, { status: 400 });
			}
			const port = serving.port;
			if (port === undefined)
				return Response.json({ error: "not_listening" }, { status: 503 });
			return rest.handle({ request, port });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				const hello = gateway.open(socket.data.requestUrl);
				if (hello === undefined) socket.close(4002, "invalid Gateway query");
				else socket.send(hello);
			},
			message(socket, raw) {
				const result = gateway.receive(raw);
				switch (result.kind) {
					case "identify":
						for (const frame of result.frames) socket.send(frame);
						return;
					case "heartbeat":
						socket.send(result.frame);
						return;
					case "reject":
						socket.close(4002, result.reason);
						return;
					default:
						assertNever(result);
				}
			},
			close(socket) {
				sockets.delete(socket);
			},
		},
	});
	boundPort = server.port;
	if (boundPort === undefined)
		throw new Error("fake Discord did not bind a port");
	const port = boundPort;
	console.log(`FAKE_DISCORD_PORT=${port}`);
	return {
		port,
		baseUrl: `http://127.0.0.1:${port}`,
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		events: () => [...events],
		handshake: gateway.snapshot,
		disconnectGateway() {
			for (const socket of sockets) socket.close(4000, "test disconnect");
		},
		async stop() {
			if (stopped) return;
			stopped = true;
			for (const socket of sockets) socket.close(1001, "server stopping");
			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const fake = startFakeDiscord();
	const stop = (): void => {
		void fake.stop().then(() => process.exit(0));
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}
