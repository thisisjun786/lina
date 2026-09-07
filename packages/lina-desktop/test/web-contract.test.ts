import { expect, test } from "bun:test";
import { startWebServer } from "../../lina-web/src/server.ts";
import { startBroker } from "../src/broker.ts";
import { createBrokerSession } from "../src/session.ts";

test("actual Lina web keeps its origin checks while HTTP and WS cross the desktop bridge", async () => {
	const runtime = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, server) {
			if (new URL(request.url).pathname === "/" && server.upgrade(request))
				return;
			return Response.json({ received: new URL(request.url).pathname });
		},
		websocket: {
			open(socket) {
				socket.send(JSON.stringify({ type: "agent-status", state: "idle" }));
			},
			message(socket, raw) {
				const frame = JSON.parse(String(raw));
				if (frame.type === "ping")
					socket.send(
						JSON.stringify({
							type: "pong",
							sessionId: frame.sessionId,
							nonce: frame.nonce,
						}),
					);
			},
		},
	});
	const web = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${runtime.port}`,
		assets: { html: "web-only", script: "", css: "", icon: "" },
	});
	const upstream = `http://127.0.0.1:${web.port}`;
	const session = createBrokerSession();
	const broker = await startBroker({
		port: 0,
		serverOrigin: upstream,
		session,
		assets: new Map([
			["/", { body: Buffer.from("desktop-only"), mime: "text/html" }],
		]),
	});
	const headers = {
		Origin: broker.origin,
		Cookie: `lina_desktop=${session.cookie(broker.origin).value}`,
	};
	let socket: WebSocket | undefined;
	try {
		expect(
			(
				await fetch(`${upstream}/api/tasks`, {
					headers: { Origin: broker.origin },
				})
			).status,
		).toBe(403);
		const response = await fetch(`${broker.origin}/api/tasks`, { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ received: "/api/tasks" });
		expect(await (await fetch(broker.origin, { headers })).text()).toBe(
			"desktop-only",
		);
		socket = new WebSocket(`${broker.origin.replace("http:", "ws:")}/ws`, {
			headers,
		});
		const active = socket;
		await new Promise<void>((resolve, reject) => {
			active.addEventListener("error", () =>
				reject(Error("Desktop WS failed")),
			);
			active.addEventListener("message", (event) => {
				const frame = JSON.parse(String(event.data));
				if (frame.type === "agent-status") {
					expect(frame.state).toBe("idle");
					active.send(
						JSON.stringify({
							type: "ping",
							sessionId: "scope",
							nonce: "probe",
						}),
					);
				} else {
					expect(frame).toEqual({
						type: "pong",
						sessionId: "scope",
						nonce: "probe",
					});
					resolve();
				}
			});
		});
	} finally {
		socket?.close();
		await broker.close();
		await web.stop(true);
		await runtime.stop(true);
	}
});
