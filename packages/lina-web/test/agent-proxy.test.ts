import { expect, test } from "bun:test";
import { startWebServer } from "../src/server.ts";

test("agent management strips credentials and bounds upstream bodies", async () => {
	const seen: Request[] = [];
	let large = false;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen.push(request);
			return large
				? new Response("x".repeat(2200000))
				: Response.json({ ok: true });
		},
	});
	const server = startWebServer({
			port: 0,
			upstream: `ws://127.0.0.1:${upstream.port}`,
			assets: { html: "ok", script: "", css: "", icon: "" },
		}),
		base = `http://127.0.0.1:${server.port}`;
	try {
		expect(
			(await fetch(`${base}/api/agents`, { method: "POST", body: "{}" }))
				.status,
		).toBe(403);
		const result = await fetch(`${base}/api/agents/lina`, {
			method: "PATCH",
			headers: {
				Origin: base,
				Authorization: "secret",
				Cookie: "secret",
				"Content-Type": "application/json",
			},
			body: "{}",
		});
		expect(result.status).toBe(200);
		expect(seen[0]?.headers.has("Origin")).toBe(false);
		expect(seen[0]?.headers.has("Authorization")).toBe(false);
		expect(seen[0]?.headers.has("Cookie")).toBe(false);
		large = true;
		expect(
			(
				await fetch(`${base}/api/agents`, {
					headers: { "Sec-Fetch-Site": "same-origin" },
				})
			).status,
		).toBe(502);
	} finally {
		await server.stop(true);
		await upstream.stop(true);
	}
});

test("visual management forwards only explicit CAS headers and its binary reference bound", async () => {
	let seen: Headers | undefined;
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen = new Headers(request.headers);
			return Response.json({ ok: true });
		},
	});
	const web = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets: { html: "ok", script: "", css: "", icon: "" },
	});
	const base = `http://127.0.0.1:${web.port}`;
	try {
		expect(
			(
				await fetch(`${base}/api/agents/lina/visual/references`, {
					method: "POST",
					headers: {
						Origin: base,
						"X-Lina-Filename": "reference.png",
						"X-Lina-Profile-Revision": "1",
						"X-Lina-Visual-Revision": "1",
						"X-Lina-Request-Key": "reference-retry",
						Authorization: "private",
					},
					body: new Uint8Array(16),
				})
			).status,
		).toBe(200);
		expect(seen?.get("X-Lina-Profile-Revision")).toBe("1");
		expect(seen?.get("X-Lina-Request-Key")).toBe("reference-retry");
		expect(seen?.has("authorization")).toBe(false);
		expect(
			(
				await fetch(`${base}/api/agents/lina/visual`, {
					method: "PUT",
					headers: { Origin: base, "content-type": "application/json" },
					body: JSON.stringify({ expectedRevision: 1, visual: {} }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await fetch(`${base}/api/agents/lina/visual/references`, {
					method: "POST",
					headers: { Origin: base },
					body: new Uint8Array(2_097_153),
				})
			).status,
		).toBe(413);
	} finally {
		await web.stop(true);
		await upstream.stop(true);
	}
});

test("hub and task routes preserve owner-origin checks and never forward browser credentials", async () => {
	const seen: Request[] = [];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			seen.push(request);
			return Response.json({ ok: true });
		},
	});
	const web = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}`,
		assets: { html: "ok", script: "", css: "", icon: "" },
	});
	const base = `http://127.0.0.1:${web.port}`;
	try {
		for (const path of [
			"/api/hub/refresh",
			"/api/tasks",
			"/api/tasks/task-1/messages",
			"/api/tasks/task-1/interrupt",
			"/api/tasks/task-1/owner",
		]) {
			expect(
				(await fetch(base + path, { method: "POST", body: "{}" })).status,
			).toBe(403);
			expect(
				(
					await fetch(base + path, {
						method: "POST",
						headers: {
							origin: base,
							authorization: "do-not-forward",
							cookie: "private",
						},
						body: "{}",
					})
				).status,
			).toBe(200);
		}
		for (const r of seen) {
			expect(r.headers.has("authorization")).toBe(false);
			expect(r.headers.has("cookie")).toBe(false);
		}
		expect(
			(
				await fetch(base + "/api/hub/status?token=x", {
					headers: { origin: base },
				})
			).status,
		).toBe(400);
	} finally {
		await web.stop(true);
		await upstream.stop(true);
	}
});
