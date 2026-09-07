const HELLO_HEARTBEAT_MS = 41_250;

type GatewayData = { readonly requestUrl: string };

export type IdentifyCapture = {
	readonly query: string;
	readonly intents: number;
};

export type FakeGateway = {
	readonly port: number;
	readonly identified: Promise<IdentifyCapture>;
	stop(): void;
};

export function gatewayQuery(requestUrl: string): string {
	const search = new URL(requestUrl).search;
	return search.startsWith("?") ? search.slice(1) : search;
}

export function readIdentify(
	payload: unknown,
): { readonly intents: number; readonly properties: unknown } | undefined {
	if (typeof payload !== "object" || payload === null) {
		return undefined;
	}
	if (!("op" in payload) || payload.op !== 2) {
		return undefined;
	}
	if (
		!("d" in payload) ||
		typeof payload.d !== "object" ||
		payload.d === null
	) {
		return undefined;
	}
	if (!("intents" in payload.d) || typeof payload.d.intents !== "number") {
		return undefined;
	}
	const properties =
		"properties" in payload.d ? payload.d.properties : undefined;
	return { intents: payload.d.intents, properties };
}

function parseGatewayFrame(raw: string | Buffer | ArrayBuffer): unknown {
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
	return JSON.parse(text);
}

function wrapFrameError(error: unknown): Error {
	if (error instanceof SyntaxError) {
		return new Error("non-json gateway frame (compression or etf encoding?)");
	}
	if (error instanceof Error) {
		return error;
	}
	return new Error(String(error));
}

function gatewayBotBody(port: number): unknown {
	return {
		url: `ws://127.0.0.1:${port}/gateway`,
		shards: 1,
		session_start_limit: {
			total: 1000,
			remaining: 999,
			reset_after: 0,
			max_concurrency: 1,
		},
	};
}

/** Local Discord REST + Gateway stand-in. Todo 14 reuses this Bun.serve upgrade surface. */
export function startFakeGateway(): FakeGateway {
	const identified = Promise.withResolvers<IdentifyCapture>();
	const server = Bun.serve<GatewayData>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			if (url.pathname === "/gateway") {
				if (srv.upgrade(req, { data: { requestUrl: req.url } })) {
					return;
				}
				return new Response("upgrade failed", { status: 400 });
			}
			if (url.pathname.endsWith("/gateway/bot")) {
				const listenPort = srv.port;
				if (listenPort === undefined) {
					return new Response("no port", { status: 500 });
				}
				return Response.json(gatewayBotBody(listenPort));
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				console.error(`gateway query: ${gatewayQuery(ws.data.requestUrl)}`);
				ws.send(
					JSON.stringify({
						op: 10,
						d: { heartbeat_interval: HELLO_HEARTBEAT_MS },
					}),
				);
			},
			message(ws, raw) {
				let payload: unknown;
				try {
					payload = parseGatewayFrame(raw);
				} catch (error) {
					identified.reject(wrapFrameError(error));
					return;
				}
				const body = readIdentify(payload);
				if (body === undefined) {
					return;
				}
				console.error(
					`identify intents=${body.intents} properties=${JSON.stringify(body.properties)}`,
				);
				identified.resolve({
					query: gatewayQuery(ws.data.requestUrl),
					intents: body.intents,
				});
			},
		},
	});
	const listenPort = server.port;
	if (listenPort === undefined) {
		void server.stop(true);
		throw new Error("fake gateway bound no port");
	}
	return {
		port: listenPort,
		identified: identified.promise,
		stop(): void {
			void server.stop(true);
		},
	};
}
