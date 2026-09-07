import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { startBroker } from "../src/broker.ts";
import { createBrokerSession } from "../src/session.ts";

// Executed as compiled Node code, independent of Bun's node:http compatibility layer.
const upstream = createServer((req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(
		JSON.stringify({
			origin: req.headers.origin,
			cookie: req.headers.cookie ?? null,
		}),
	);
});
upstream.listen(0, "127.0.0.1");
await once(upstream, "listening");
const address = upstream.address();
assert(address && typeof address !== "string");
const serverOrigin = `http://127.0.0.1:${address.port}`;
const session = createBrokerSession();
const broker = await startBroker({
	port: 0,
	serverOrigin,
	session,
	assets: new Map([["/", { body: Buffer.from("bundled"), mime: "text/html" }]]),
});
try {
	// An unauthenticated peer can reset immediately after writing the upgrade.
	// Native Node emits an asynchronous write error while sending the rejection.
	for (let attempt = 0; attempt < 16; attempt++) {
		await new Promise<void>((resolve, reject) => {
			const socket = connect(Number(new URL(broker.origin).port), "127.0.0.1");
			socket.once("error", reject);
			socket.once("close", () => resolve());
			socket.once("connect", () =>
				socket.write(
					`GET /ws HTTP/1.1\r\nHost: ${new URL(broker.origin).host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n`,
					() => socket.resetAndDestroy(),
				),
			);
		});
	}
	assert.equal((await fetch(broker.origin)).status, 403);
	const response = await fetch(`${broker.origin}/api/agents`, {
		headers: {
			origin: broker.origin,
			cookie: `lina_desktop=${session.cookie(broker.origin).value}`,
		},
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		origin: serverOrigin,
		cookie: null,
	});
	console.log(
		"Node desktop broker: TCP reset survival, auth, upstream Host/Origin, secret stripping PASS",
	);
} finally {
	await broker.close();
	upstream.closeAllConnections();
	await new Promise<void>((resolve) => upstream.close(() => resolve()));
}
