import type { ServerWebSocket } from "bun";
import { parseServerFrame } from "../../lina-client/src/protocol.ts";
import { parseContextClient } from "../../lina-core/src/context-wire.ts";
import { parseControlClient } from "../../lina-core/src/control-wire.ts";
import { parseWireClient } from "../../lina-core/src/wire.ts";
import { createAccessPolicy } from "./access.ts";
import { proxyAgents } from "./agent-proxy.ts";
import { proxyAttachment } from "./attachment-proxy.ts";

import type { PwaAssets } from "./pwa-assets.ts";

export type WebAssets = {
	readonly pwa?: PwaAssets;
	readonly themeScript?: string;
	readonly html: string;
	readonly script: string;
	readonly css: string;
	readonly icon: string;
};
type Peer = { upstream: WebSocket | undefined; agentId: string };
type Options = {
	readonly port: number;
	readonly hostname?: "127.0.0.1" | "0.0.0.0";
	readonly upstream: string;
	readonly assets: WebAssets;
	readonly publicOrigin?: string;
};
const HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; manifest-src 'self'; worker-src 'self'",
};

export function validateUpstream(raw: string): string {
	const url = new URL(raw);
	if (
		url.protocol !== "ws:" ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error(
			"LINA_INTERVENTION_URL must be a loopback ws:// URL without credentials.",
		);
	}
	return url.href;
}

export function startWebServer(options: Options) {
	const upstream = validateUpstream(options.upstream);
	const access = createAccessPolicy(options.publicOrigin);
	return Bun.serve<Peer>({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (
				request.method === "POST" &&
				/^\/api\/(?:onboarding\/(?:interview|preview)|agents\/(?:birth|[a-z][a-z0-9-]{0,47}\/intro\/(?:turn|choose)))$/.test(
					url.pathname,
				)
			)
				server.timeout(request, 75);
			const host = request.headers.get("host");
			if (!access.allowsHost(host))
				return new Response("Forbidden", { status: 403, headers: HEADERS });
			if (url.pathname === "/ws") {
				const agentId = url.searchParams.get("agent") ?? "lina";
				if (
					!/^[a-z][a-z0-9-]{0,47}$/.test(agentId) ||
					url.searchParams.size > (url.searchParams.has("agent") ? 1 : 0)
				)
					return new Response("Invalid agent", {
						status: 400,
						headers: HEADERS,
					});
				if (!access.allowsSocket(host, request.headers.get("origin")))
					return new Response("Forbidden", { status: 403, headers: HEADERS });
				return server.upgrade(request, {
					data: { upstream: undefined, agentId },
				})
					? undefined
					: new Response("WebSocket required", {
							status: 400,
							headers: HEADERS,
						});
			}
			const agentResponse = await proxyAgents(
				request,
				upstream,
				access.allowsSocket,
				HEADERS,
			);
			if (agentResponse) return agentResponse;
			const attachment = await proxyAttachment(
				request,
				upstream,
				access.allowsSocket,
				HEADERS,
			);
			if (attachment) return attachment;
			if (request.method !== "GET" && request.method !== "HEAD")
				return new Response("Method not allowed", {
					status: 405,
					headers: HEADERS,
				});
			const pwa = options.assets.pwa;
			const extra =
				pwa?.files.get(url.pathname) ??
				(url.pathname === "/sw.js" && pwa
					? { body: pwa.worker, mime: "text/javascript; charset=utf-8" }
					: url.pathname === "/manifest.webmanifest" && pwa
						? { body: pwa.manifest, mime: "application/manifest+json" }
						: undefined);
			if (extra)
				return new Response(request.method === "HEAD" ? null : extra.body, {
					headers: { ...HEADERS, "Content-Type": extra.mime },
				});
			const asset =
				url.pathname === "/"
					? [options.assets.html, "text/html; charset=utf-8"]
					: url.pathname === "/app.js"
						? [options.assets.script, "text/javascript; charset=utf-8"]
						: url.pathname === "/theme.js" && options.assets.themeScript
							? [options.assets.themeScript, "text/javascript; charset=utf-8"]
							: url.pathname === "/styles.css"
								? [options.assets.css, "text/css; charset=utf-8"]
								: url.pathname === "/favicon.svg"
									? [options.assets.icon, "image/svg+xml"]
									: undefined;
			if (asset?.[0] === undefined || asset[1] === undefined)
				return new Response("Not found", { status: 404, headers: HEADERS });
			return new Response(request.method === "HEAD" ? null : asset[0], {
				headers: { ...HEADERS, "Content-Type": asset[1] },
			});
		},
		websocket: {
			maxPayloadLength: 65_536,
			idleTimeout: 0,
			open(peer) {
				const target = new URL(upstream);
				if (peer.data.agentId !== "lina")
					target.searchParams.set("agent", peer.data.agentId);
				connectUpstream(peer, target.href);
			},
			message(peer, raw) {
				const text = typeof raw === "string" ? raw : raw.toString();
				const frame =
					parseWireClient(text) ??
					parseControlClient(text) ??
					parseContextClient(text);
				if (frame === undefined) {
					peer.send(
						JSON.stringify({ type: "error", message: "Invalid chat frame" }),
					);
					peer.close(1008, "Invalid chat");
					return;
				}
				if (peer.data.upstream?.readyState !== WebSocket.OPEN) {
					peer.close(1013, "Lina unavailable");
					return;
				}
				peer.data.upstream.send(JSON.stringify(frame));
			},
			close(peer) {
				peer.data.upstream?.close();
				peer.data.upstream = undefined;
			},
		},
	});
}

function connectUpstream(peer: ServerWebSocket<Peer>, target: string): void {
	const socket = new WebSocket(target);
	peer.data.upstream = socket;
	socket.addEventListener("message", (event: MessageEvent<unknown>) => {
		if (peer.readyState !== WebSocket.OPEN) return;
		const frame = parseServerFrame(event.data);
		if (frame !== undefined) peer.send(JSON.stringify(frame));
	});
	socket.addEventListener("close", () => peer.close(1013, "Lina disconnected"));
	socket.addEventListener("error", () => {
		socket.close();
		peer.close(1013, "Lina unavailable");
	});
}
