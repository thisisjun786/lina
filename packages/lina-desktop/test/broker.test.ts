import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { createAccessPolicy } from "../../lina-web/src/access.ts";
import { startBroker } from "../src/broker.ts";
import { createBrokerSession } from "../src/session.ts";

const assets = new Map([
	["/", { body: Buffer.from("<html>bundled Lina</html>"), mime: "text/html" }],
]);
const uuid = "01234567-89ab-4cde-8fab-0123456789ab";
const pending: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of pending.splice(0).reverse()) await close();
});

async function fixture() {
	const seen: Array<{
		path: string;
		headers: IncomingHttpHeaders;
		body: string;
	}> = [];
	const upstream = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		seen.push({ path: req.url ?? "", headers: req.headers, body });
		const access = createAccessPolicy();
		if (
			!access.allowsSocket(
				req.headers.host ?? null,
				String(req.headers.origin ?? ""),
			)
		) {
			res.writeHead(403);
			res.end();
			return;
		}
		if (req.url === "/api/models") {
			res.writeHead(302, { location: "http://127.0.0.1:1/private" });
			res.end();
			return;
		}
		res.writeHead(200, {
			"content-type": "application/json",
			"set-cookie": "upstream=leaked",
			"content-disposition": "attachment; filename=test.txt",
		});
		res.end(JSON.stringify({ path: req.url, body }));
	});
	upstream.listen(0, "127.0.0.1");
	await once(upstream, "listening");
	const addr = upstream.address();
	if (!addr || typeof addr === "string") throw Error("No upstream port");
	const origin = `http://127.0.0.1:${addr.port}`;
	const session = createBrokerSession();
	const broker = await startBroker({
		port: 0,
		serverOrigin: origin,
		assets,
		session,
	});
	pending.push(async () => {
		upstream.closeAllConnections();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	});
	pending.push(broker.close);
	const cookie = `lina_desktop=${session.cookie(broker.origin).value}`;
	const auth = { cookie, origin: broker.origin };
	return { upstream, origin, seen, broker, cookie, auth };
}

function raw(
	origin: string,
	path: string,
	headers: Record<string, string>,
	method = "GET",
	body?: string,
) {
	return new Promise<{
		status: number;
		headers: IncomingHttpHeaders;
		body: string;
	}>((resolve, reject) => {
		const req = request(origin, { path, method, headers }, (res) => {
			let text = "";
			res.on("data", (chunk) => {
				text += chunk.toString();
			});
			res.on("end", () =>
				resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: text,
				}),
			);
			res.on("error", reject);
		});
		req.on("error", reject);
		req.end(body);
	});
}

describe("main-owned loopback broker", () => {
	let f: Awaited<ReturnType<typeof fixture>>;
	beforeEach(async () => {
		f = await fixture();
	});
	test("never issues credentials from root; bundled UI loads without upstream", async () => {
		const anonymous = await raw(f.broker.origin, "/", {});
		expect(anonymous.status).toBe(403);
		expect(anonymous.headers["set-cookie"]).toBeUndefined();
		const page = await raw(f.broker.origin, "/?agent=lina", {
			cookie: f.cookie,
		});
		expect(page.status).toBe(200);
		expect(page.body).toContain("bundled Lina");
		expect(page.body).not.toContain(f.cookie);
		expect(page.headers["content-security-policy"]).toContain(
			"worker-src 'none'",
		);
		expect(f.seen.length).toBe(0);
	});
	test("rejects missing session, forged Host, hostile/missing Origin and cross-port same-site", async () => {
		for (const headers of [
			{ origin: f.broker.origin },
			{ ...f.auth, host: "evil.test" },
			{ ...f.auth, origin: "http://evil.test" },
			{ ...f.auth, origin: "null" },
			{ ...f.auth, origin: "http://127.0.0.1:9999" },
			{ cookie: f.cookie },
			{ cookie: f.cookie, "sec-fetch-site": "same-site" },
		]) {
			expect((await raw(f.broker.origin, "/api/agents", headers)).status).toBe(
				403,
			);
		}
		expect(
			(
				await raw(f.broker.origin, "/", {
					...f.auth,
					origin: "https://evil.test",
				})
			).status,
		).toBe(403);
		expect(f.seen.length).toBe(0);
	});
	test("forwards exact contracts and metadata with pinned server Host/Origin and strips cookies", async () => {
		const upload = await raw(
			f.broker.origin,
			"/api/attachments",
			{
				...f.auth,
				"x-lina-session": uuid,
				"x-lina-filename": "note.txt",
				"content-type": "application/octet-stream",
				authorization: "do-not-forward",
				"x-forwarded-host": "evil.test",
			},
			"POST",
			"attachment bytes",
		);
		expect(upload.status).toBe(200);
		expect(upload.headers["set-cookie"]).toBeUndefined();
		expect(upload.headers["content-disposition"]).toBe(
			"attachment; filename=test.txt",
		);
		expect(f.seen[0]?.headers).toMatchObject({
			host: new URL(f.origin).host,
			origin: f.origin,
			"x-lina-session": uuid,
			"x-lina-filename": "note.txt",
		});
		expect(f.seen[0]?.headers.cookie).toBeUndefined();
		expect(f.seen[0]?.headers.authorization).toBeUndefined();
		expect(f.seen[0]?.headers["x-forwarded-host"]).toBeUndefined();
		expect(f.seen[0]?.body).toBe("attachment bytes");
		const file = await raw(
			f.broker.origin,
			`/api/attachments/${uuid}/preview?sessionId=${uuid}`,
			{ cookie: f.cookie, "sec-fetch-site": "same-origin" },
		);
		expect(file.status).toBe(200);
		for (const [path, method] of [
			["/api/tasks", "POST"],
			["/api/tasks/native_1/approval", "POST"],
			["/api/onboarding/user", "PATCH"],
			[`/api/onboarding/drafts/${uuid}`, "PATCH"],
			["/api/agents/lina/memory", "POST"],
			["/api/onboarding/entry", "GET"],
			[`/api/onboarding/rooms/${uuid}`, "GET"],
			["/api/agents/lina/intro/turn", "POST"],
			["/api/agents/lina/conversation", "PATCH"],
		] as const) {
			expect(
				(
					await raw(
						f.broker.origin,
						path,
						f.auth,
						method,
						method === "GET" ? undefined : "{}",
					)
				).status,
			).toBe(200);
		}
	});
	test("rejects unknown endpoints, traversal, query injection, unsupported methods and redirects", async () => {
		for (const path of [
			"/api/private",
			"/api/agents/../models",
			"/api/%61gents",
			"/api/agents?target=http://evil.test",
			"//evil.test/api/agents",
			"http://evil.test/api/agents",
			`/api/attachments/${uuid}?sessionId=${uuid}&sessionId=${uuid}`,
			"/sw.js",
		]) {
			expect(
				(await raw(f.broker.origin, path, f.auth)).status,
			).toBeGreaterThanOrEqual(400);
		}
		expect(
			(await raw(f.broker.origin, "/api/agents", f.auth, "DELETE")).status,
		).toBe(405);
		expect(
			(await raw(f.broker.origin, "/api/models", f.auth, "POST", "{}")).status,
		).toBe(405);
		expect(f.seen.length).toBe(0);
		const redirect = await raw(f.broker.origin, "/api/models", f.auth);
		expect(redirect.status).toBe(502);
		expect(redirect.headers.location).toBeUndefined();
		expect(f.seen.length).toBe(1);
	});
	test("bounds uploads before reaching upstream", async () => {
		expect(
			(
				await raw(
					f.broker.origin,
					"/api/attachments",
					{ ...f.auth, "content-length": "2097153" },
					"POST",
				)
			).status,
		).toBe(413);
		expect(f.seen.length).toBe(0);
	});
	test("returns recoverable failure offline, keeps assets available and resumes on next request", async () => {
		await new Promise<void>((resolve) => f.upstream.close(() => resolve()));
		expect((await raw(f.broker.origin, "/api/agents", f.auth)).status).toBe(
			502,
		);
		expect((await raw(f.broker.origin, "/", { cookie: f.cookie })).status).toBe(
			200,
		);
		f.upstream.listen(Number(new URL(f.origin).port), "127.0.0.1");
		await once(f.upstream, "listening");
		expect((await raw(f.broker.origin, "/api/agents", f.auth)).status).toBe(
			200,
		);
	});
	test("WS rejects non-upgrade responses and a forged upstream handshake", async () => {
		const headers = {
			...f.auth,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": randomBytes(16).toString("base64"),
		};
		expect((await raw(f.broker.origin, "/ws", headers)).status).toBe(502);
		f.upstream.once("upgrade", (_req, socket) => {
			socket.end(
				"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: forged\r\n\r\n",
			);
		});
		expect((await raw(f.broker.origin, "/ws", headers)).status).toBe(502);
	});

	test("busy stable port fails without allocating a different renderer origin", async () => {
		await expect(
			startBroker({
				port: Number(new URL(f.broker.origin).port),
				serverOrigin: f.origin,
				assets,
				session: createBrokerSession(),
			}),
		).rejects.toThrow();
		expect((await raw(f.broker.origin, "/", { cookie: f.cookie })).status).toBe(
			200,
		);
	});

	test("WS requires cookie + exact Origin, validates path, and pins upstream handshake", async () => {
		const headers = {
			...f.auth,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": randomBytes(16).toString("base64"),
		};
		for (const [path, override] of [
			["/ws", { origin: "https://evil.test" }],
			["/ws", { cookie: "" }],
			["/ws?agent=lina&target=evil", {}],
			["/api/agents", {}],
		] as const) {
			expect(
				(await raw(f.broker.origin, path, { ...headers, ...override })).status,
			).toBeGreaterThanOrEqual(400);
		}
		const handshake = new Promise<IncomingHttpHeaders>((resolve) =>
			f.upstream.once("upgrade", (req, socket) => {
				resolve(req.headers);
				const accept = createHash("sha1")
					.update(
						`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
					)
					.digest("base64");
				socket.write(
					`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				);
				socket.on("data", (data) => socket.write(data));
				socket.on("end", () => socket.end());
			}),
		);
		await new Promise<void>((resolve, reject) => {
			const req = request(f.broker.origin, { path: "/ws?agent=lina", headers });
			req.on("error", reject);
			req.on("upgrade", (_res, socket) => {
				socket.once("data", (data) => {
					expect(data.toString()).toBe("tunnel bytes");
					socket.destroy();
					resolve();
				});
				socket.write("tunnel bytes");
			});
			req.end();
		});
		const forwarded = await handshake;
		expect(forwarded.origin).toBe(f.origin);
		expect(forwarded.host).toBe(new URL(f.origin).host);
		expect(forwarded.cookie).toBeUndefined();
	});
});
