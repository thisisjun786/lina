import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { serverOrigin } from "./config.ts";
import { proxyHttp } from "./http-proxy.ts";
import { apiStatus, requestUrl, socketPath } from "./routes.ts";
import type { BrokerSession } from "./session.ts";
import { proxySocket, rejectUpgrade } from "./socket-proxy.ts";

export type BundledAsset = { readonly body: Buffer; readonly mime: string };
export type BundledAssets = ReadonlyMap<string, BundledAsset>;
const SECURITY = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"x-frame-options": "DENY",
	"referrer-policy": "no-referrer",
	"cross-origin-resource-policy": "same-origin",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'none'",
};

function trusted(
	request: IncomingMessage,
	origin: string,
	session: BrokerSession,
	active: boolean,
): boolean {
	for (const name of ["host", "origin", "cookie"]) {
		if (
			request.rawHeaders.filter(
				(_, i) => i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === name,
			).length > 1
		)
			return false;
	}
	if (
		request.headers.host !== new URL(origin).host ||
		!session.authorizes(request.headers.cookie)
	)
		return false;
	const supplied = request.headers.origin;
	if (supplied !== undefined) return supplied === origin;
	return (
		!active ||
		(request.method === "GET" &&
			request.headers["sec-fetch-site"] === "same-origin")
	);
}

export async function startBroker(options: {
	port: number;
	serverOrigin: string;
	session: BrokerSession;
	assets: BundledAssets;
}) {
	const targetOrigin = serverOrigin(
		`${options.serverOrigin}${new URL(options.serverOrigin).port ? "" : ":80"}`,
	);
	let origin = "";
	const sockets = new Set<Socket>();
	let upgrades = 0;
	const server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
		for (const [key, value] of Object.entries(SECURITY))
			res.setHeader(key, value);
		const fail = (status: number, message: string) => {
			res.writeHead(status);
			res.end(message);
			req.resume();
		};
		const url = requestUrl(req.url, origin);
		if (!url) {
			fail(400, "Invalid path");
			return;
		}
		const api = url.pathname.startsWith("/api/");
		if (!trusted(req, origin, options.session, api)) {
			fail(403, "Forbidden");
			return;
		}
		if (api) {
			const status = apiStatus(url, req.method ?? "");
			if (status !== 0) {
				fail(status ?? 404, "Unsupported request");
				return;
			}
			res.setHeader(
				"content-security-policy",
				"default-src 'none'; frame-ancestors 'none'; sandbox",
			);
			void proxyHttp(
				req,
				res,
				new URL(url.pathname + url.search, targetOrigin),
			);
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			fail(405, "Method not allowed");
			return;
		}
		const asset = options.assets.get(url.pathname);
		if (!asset || (url.search && url.pathname !== "/")) {
			fail(404, "Not found");
			return;
		}
		res.setHeader("content-type", asset.mime);
		res.end(req.method === "HEAD" ? undefined : asset.body);
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 90_000;
	server.keepAliveTimeout = 5_000;
	server.maxConnections = 64;
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (req, socket, head) => {
		const url = requestUrl(req.url, origin);
		if (
			!trusted(req, origin, options.session, true) ||
			req.headers.origin !== origin
		) {
			rejectUpgrade(socket, 403);
			return;
		}
		if (!url || req.method !== "GET" || !socketPath(url)) {
			rejectUpgrade(socket, 400);
			return;
		}
		if (upgrades >= 8) {
			rejectUpgrade(socket, 429);
			return;
		}
		upgrades++;
		socket.once("close", () => {
			upgrades--;
		});
		proxySocket(
			req,
			socket,
			head,
			new URL(url.pathname + url.search, targetOrigin),
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing desktop broker port");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		origin,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			}),
	};
}
