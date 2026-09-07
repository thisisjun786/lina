import { expect, test } from "bun:test";
import { startWebServer } from "../src/server.ts";

const sid = "12345678-1234-4234-8234-123456789012",
	id = "87654321-1234-4234-8234-123456789012";
const assets = { html: "ok", script: "", css: "", icon: "" };
test("attachment proxy enforces browser origin and forwards only bounded owned fields", async () => {
	const seen: Request[] = [];
	let uploaded = "";
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			seen.push(request);
			uploaded = await request.text();
			return Response.json({ id, name: "note.txt" });
		},
	});
	const server = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets,
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		for (const origin of [undefined, "null", "https://evil.test"]) {
			const response = await fetch(`${base}/api/attachments`, {
				method: "POST",
				headers: {
					...(origin ? { Origin: origin } : {}),
					"X-Lina-Session": sid,
					"X-Lina-Filename": "note.txt",
				},
				body: "private",
			});
			expect(response.status).toBe(403);
		}
		expect(seen).toHaveLength(0);
		const headers = {
			Origin: base,
			"X-Lina-Session": sid,
			"X-Lina-Filename": "note.txt",
			Cookie: "secret",
			Authorization: "secret",
		};
		const sent = await fetch(`${base}/api/attachments`, {
			method: "POST",
			headers,
			body: "hello",
		});
		expect(sent.status).toBe(200);
		expect(uploaded).toBe("hello");
		expect(seen[0]?.headers.get("Origin")).toBeNull();
		expect(seen[0]?.headers.get("Authorization")).toBeNull();
		expect(seen[0]?.headers.get("Cookie")).toBeNull();
		expect(seen[0]?.headers.get("X-Lina-Session")).toBe(sid);
		expect(
			(await fetch(`${base}/api/attachments/${id}?sessionId=${sid}`)).status,
		).toBe(403);
		const read = await fetch(`${base}/api/attachments/${id}?sessionId=${sid}`, {
			headers: { "Sec-Fetch-Site": "same-origin" },
		});
		expect(read.status).toBe(200);
		expect(read.headers.get("Cache-Control")).toBe("no-store");
		expect(
			(
				await fetch(`${base}/api/attachments`, {
					method: "POST",
					headers,
					body: "x".repeat(2097153),
				})
			).status,
		).toBe(413);
		expect(seen).toHaveLength(2);
	} finally {
		await server.stop(true);
		await upstream.stop(true);
	}
});
test("redirect responses and unexpected API paths do not leak data through the proxy", async () => {
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.redirect("https://example.com/private"),
	});
	const server = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets,
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		expect(
			(
				await fetch(`${base}/api/attachments/${id}?sessionId=${sid}`, {
					headers: { "Sec-Fetch-Site": "same-origin" },
				})
			).status,
		).toBe(502);
		expect(
			(await fetch(`${base}/api/attachments/${id}/unknown?sessionId=${sid}`))
				.status,
		).toBe(404);
	} finally {
		await server.stop(true);
		await upstream.stop(true);
	}
});
