import { createHash } from "node:crypto";
import { type IncomingMessage, request } from "node:http";
import type { Duplex } from "node:stream";

export function rejectUpgrade(socket: Duplex, status: number): void {
	// HTTP removes its socket error handler on upgrade. A peer may reset before
	// this rejection is written, including on paths that never create a tunnel.
	socket.once("error", () => socket.destroy());
	socket.end(
		`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
}

/** Node streams enforce backpressure; Lina web remains the wire parser/limit owner. */
export function proxySocket(
	incoming: IncomingMessage,
	client: Duplex,
	head: Buffer,
	target: URL,
): void {
	const key = incoming.headers["sec-websocket-key"];
	if (
		incoming.headers.upgrade?.toLowerCase() !== "websocket" ||
		incoming.headers["sec-websocket-version"] !== "13" ||
		typeof key !== "string" ||
		!/^[A-Za-z0-9+/]{22}==$/.test(key) ||
		incoming.headers["sec-websocket-protocol"]
	) {
		rejectUpgrade(client, 400);
		return;
	}
	const expected = createHash("sha1")
		.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
		.digest("base64");
	const upstream = request(target, {
		headers: {
			origin: target.origin,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": key,
		},
	});
	let peer: Duplex | undefined;
	const deadline = setTimeout(
		() => upstream.destroy(Error("Handshake timeout")),
		10_000,
	);
	const dispose = () => {
		clearTimeout(deadline);
		peer?.destroy();
		upstream.destroy();
	};
	client.once("close", dispose);
	client.once("error", dispose);
	upstream.once("error", () => {
		clearTimeout(deadline);
		if (!peer && !client.destroyed) rejectUpgrade(client, 502);
		else client.destroy();
	});
	upstream.once("response", (response) => {
		response.destroy();
		clearTimeout(deadline);
		rejectUpgrade(client, 502);
	});
	upstream.once("upgrade", (response, socket, initial) => {
		clearTimeout(deadline);
		if (
			client.destroyed ||
			response.statusCode !== 101 ||
			response.headers.upgrade?.toLowerCase() !== "websocket" ||
			response.headers["sec-websocket-accept"] !== expected ||
			response.headers["sec-websocket-extensions"] ||
			response.headers["sec-websocket-protocol"]
		) {
			socket.destroy();
			rejectUpgrade(client, 502);
			return;
		}
		peer = socket;
		socket.once("error", () => client.destroy());
		socket.once("close", () => client.destroy());
		client.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${expected}\r\n\r\n`,
		);
		if (initial.length) client.write(initial);
		if (head.length) socket.write(head);
		client.pipe(socket);
		socket.pipe(client);
	});
	upstream.end();
}
