import { afterEach, expect, test } from "bun:test";
import { startWebServer } from "../src/server.ts";

const FEED = "/api/life/worlds/world-1/feed";
// Synthetic wire-format sample; never minted by or used with a real grant store.
const BEARER = `Bearer llv1_${"a".repeat(43)}`;
const REPLY = { requestKey: "reply-1", expectedPostRevision: 1, text: "안녕" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
});

function fixture(respond: () => Response = () => Response.json({ posts: [] })) {
	const seen: { url: URL; method: string; headers: Headers; body: string }[] =
		[];
	const upstream = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			seen.push({
				url: new URL(request.url),
				method: request.method,
				headers: new Headers(request.headers),
				body: await request.text(),
			});
			return respond();
		},
	});
	cleanup.push(() => upstream.stop(true));
	const server = startWebServer({
		port: 0,
		upstream: `ws://127.0.0.1:${upstream.port}/ws?agent=private`,
		publicOrigin: "https://lina.example.test",
		assets: { html: "ok", script: "", css: "", icon: "" },
	});
	cleanup.push(() => server.stop(true));
	const base = `http://127.0.0.1:${server.port}`;
	function request(path = FEED, init: RequestInit = {}) {
		const headers = new Headers({ Origin: base, Authorization: BEARER });
		new Headers(init.headers).forEach((value, key) => {
			headers.set(key, value);
		});
		return fetch(base + path, { ...init, headers, redirect: "manual" });
	}
	function json(path: string, method: string, body: unknown) {
		return request(path, {
			method,
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify(body),
		});
	}
	return { seen, upstream, base, request, json };
}

function security(response: Response) {
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("content-security-policy")).toContain(
		"default-src 'none'",
	);
	for (const name of [
		"set-cookie",
		"authorization",
		"location",
		"x-private",
		"access-control-allow-origin",
	])
		expect(response.headers.has(name)).toBe(false);
}

test("LIFE feed forwards all seven operations with exact methods, JSON and scoped bearer only", async () => {
	const payload = {
		posts: [
			{
				id: "post-1",
				revision: 1,
				segments: [{ kind: "user_authored", text: "안녕" }],
			},
		],
	};
	const f = fixture(() =>
		Response.json(payload, {
			headers: {
				"Set-Cookie": "private=1",
				"X-Private": "internal",
				Authorization: "private",
				"Access-Control-Allow-Origin": "*",
				"Cache-Control": "public",
			},
		}),
	);
	const operations = [
		{
			path: `${FEED}?after=cursor.v1_A-~&limit=100`,
			method: "GET",
			body: undefined,
		},
		{ path: `${FEED}/posts/post-1`, method: "GET", body: undefined },
		{ path: `${FEED}/posts/post-1/replies`, method: "POST", body: REPLY },
		{
			path: `${FEED}/posts/post-1/reactions`,
			method: "PUT",
			body: {
				requestKey: "reaction-1",
				expectedPostRevision: 1,
				reactionId: "like",
				active: false,
			},
		},
		{
			path: `${FEED}/posts/post-1/reshares`,
			method: "POST",
			body: { requestKey: "reshare-1", expectedPostRevision: 1 },
		},
		{ path: `${FEED}/cursor`, method: "GET", body: undefined },
		{
			path: `${FEED}/cursor`,
			method: "PUT",
			body: { expectedRevision: 0, postId: "post-1" },
		},
	];
	for (const operation of operations) {
		const response = await f.request(operation.path, {
			method: operation.method,
			...(operation.body ? { body: JSON.stringify(operation.body) } : {}),
			headers: {
				"Content-Type": "application/json",
				Cookie: "provider-session=private",
				"Proxy-Authorization": "private",
				"X-Api-Key": "private",
				Forwarded: "host=evil.example",
				"X-Forwarded-Host": "evil.example",
				"X-Forwarded-For": "192.0.2.1",
				"X-Forwarded-Proto": "https",
				"X-Lina-Session": "private",
				"X-Lina-Recipient": "another-viewer",
				"X-HTTP-Method-Override": "DELETE",
				"Sec-Fetch-Site": "same-origin",
			},
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(payload);
		security(response);
		const captured = f.seen.at(-1);
		expect(captured?.url.origin).toBe(`http://127.0.0.1:${f.upstream.port}`);
		expect(`${captured?.url.pathname}${captured?.url.search}`).toBe(
			operation.path,
		);
		expect(captured?.method).toBe(operation.method);
		expect(captured?.body).toBe(
			operation.body ? JSON.stringify(operation.body) : "",
		);
		expect(captured?.headers.get("authorization")).toBe(BEARER);
		for (const name of [
			"cookie",
			"origin",
			"proxy-authorization",
			"x-api-key",
			"forwarded",
			"x-forwarded-host",
			"x-forwarded-for",
			"x-forwarded-proto",
			"x-lina-session",
			"x-lina-recipient",
			"x-http-method-override",
			"sec-fetch-site",
		])
			expect(captured?.headers.has(name)).toBe(false);
	}
	expect(f.seen).toHaveLength(7);
});

test("LIFE reads remain bodyless GETs on repeated feed, detail and cursor requests", async () => {
	const f = fixture();
	for (const path of [FEED, `${FEED}/posts/post-1`, `${FEED}/cursor`, FEED]) {
		const response = await f.request(path);
		expect(response.status).toBe(200);
		await response.text();
	}
	expect(f.seen.map(({ method, body }) => ({ method, body }))).toEqual(
		Array.from({ length: 4 }, () => ({ method: "GET", body: "" })),
	);
});

test("LIFE rejects missing, provider and malformed bearers before any upstream call", async () => {
	const f = fixture();
	for (const value of [
		"",
		"Bearer provider-private",
		`bearer llv1_${"a".repeat(43)}`,
		`Bearer  llv1_${"a".repeat(43)}`,
		`Bearer llv1_${"a".repeat(42)}`,
		`${BEARER}a`,
		`${BEARER}=`,
		`${BEARER}, ${BEARER}`,
		`Bearer llv1_${"/".repeat(43)}`,
		`Basic ${"a".repeat(43)}`,
	]) {
		const response = await f.request(FEED, {
			headers: { Authorization: value },
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("Forbidden");
		security(response);
	}
	const missing = await fetch(f.base + FEED, { headers: { Origin: f.base } });
	expect(missing.status).toBe(403);
	await missing.text();
	expect(f.seen).toHaveLength(0);
});

test("LIFE checks actual Host and Origin even for GET with forged same-origin metadata", async () => {
	const f = fixture();
	for (const path of [FEED, `${FEED}/cursor`, `${FEED}/posts/post-1`]) {
		for (const origin of [
			"",
			"null",
			"https://evil.example",
			`${f.base}/`,
			"http://127.0.0.1:1",
		]) {
			const response = await f.request(path, {
				headers: {
					Origin: origin,
					"Sec-Fetch-Site": "same-origin",
					"X-Forwarded-Host": new URL(f.base).host,
				},
			});
			expect(response.status).toBe(403);
			await response.text();
		}
	}
	for (const host of ["evil.example", "localhost.evil", "127.0.0.1.evil"]) {
		const response = await f.request(FEED, {
			headers: {
				Host: host,
				Origin: `http://${host}`,
				"X-Forwarded-Host": new URL(f.base).host,
			},
		});
		expect(response.status).toBe(403);
		await response.text();
	}
	const missing = await fetch(f.base + FEED, {
		headers: { Authorization: BEARER },
	});
	expect(missing.status).toBe(403);
	await missing.text();
	expect(f.seen).toHaveLength(0);
	for (const host of [new URL(f.base).host, "lina.example.test"]) {
		const response = await f.request(FEED, {
			headers: { Host: host, Origin: "https://lina.example.test" },
		});
		expect(response.status).toBe(200);
		await response.text();
	}
});

test("LIFE exposes no management, authoring or ambiguous feed paths", async () => {
	const f = fixture();
	for (const path of [
		"/api/life",
		"/api/life/drafts",
		"/api/life/author-sessions",
		"/api/life/worlds",
		...[
			"publication",
			"publication/settings",
			"publication/viewers",
			"publication/viewers/grant-1/revoke",
			"publication/run",
			"publication/jobs/job-1/retry",
			"config",
			"run",
		].map((suffix) => `/api/life/worlds/world-1/${suffix}`),
		`${FEED}/settings`,
		`${FEED}/posts`,
		`${FEED}/posts/post-1/withdraw`,
		`${FEED}/posts/post-1/`,
		`${FEED}//cursor`,
		FEED.replace("world-1", "world:1"),
		FEED.replace("world-1", "a".repeat(129)),
		FEED.replace("world-1", "%2fworld-1"),
		FEED.replace("feed", "%66eed"),
		`${FEED}/posts/%2e%2e%2fpublication`,
		`${FEED}/posts/a%5cb`,
		`${FEED}/posts/a%252fb`,
		`${FEED}/posts/.hidden`,
		`${FEED}/posts/a;run`,
	]) {
		for (const method of ["GET", "POST"]) {
			const response = await f.request(path, { method });
			expect(response.status).toBe(404);
			await response.text();
		}
	}
	expect(f.seen).toHaveLength(0);
});

test("LIFE rejects every unsupported route method without forwarding", async () => {
	const f = fixture();
	for (const [suffix, methods] of [
		["", ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]],
		["/posts/post-1", ["POST", "PUT", "PATCH"]],
		["/posts/post-1/replies", ["GET", "PUT"]],
		["/posts/post-1/reactions", ["GET", "POST"]],
		["/posts/post-1/reshares", ["GET", "PUT"]],
		["/cursor", ["POST", "DELETE"]],
	] as const) {
		for (const method of methods) {
			const response = await f.request(FEED + suffix, { method });
			expect(response.status).toBe(405);
			await response.text();
		}
	}
	expect(f.seen).toHaveLength(0);
});

test("LIFE bounds pagination and denies selectors, duplicate keys and query credentials", async () => {
	const f = fixture();
	for (const query of [
		"limit=0",
		"limit=101",
		"limit=-1",
		"limit=1.5",
		"limit=01",
		"limit=1e2",
		"limit=",
		"limit=1&limit=2",
		"after=a&after=b",
		"after=",
		"after=a%2fb",
		"after=a+b",
		"after=%zz",
		`after=${"a".repeat(2049)}`,
		`after=${BEARER.slice(7)}`,
		`after=x.${BEARER.slice(7)}`,
		"token=private",
		"authorization=private",
		"access_token=private",
		"recipientId=other",
		"actorId=other",
		"agentId=other",
		"authorId=other",
		"afterId=post-1",
		"url=http://evil.example",
		"%6cimit=1",
		"limit=1&&",
		`after=${"a".repeat(8192)}`,
	]) {
		const response = await f.request(`${FEED}?${query}`);
		expect(response.status).toBe(400);
		await response.text();
	}
	for (const suffix of ["/posts/post-1", "/cursor", "/posts/post-1/replies"]) {
		const response = await f.request(`${FEED}${suffix}?limit=1`, {
			method: suffix.endsWith("replies") ? "POST" : "GET",
		});
		expect(response.status).toBe(400);
		await response.text();
	}
	expect(f.seen).toHaveLength(0);
	for (const query of ["limit=1", `after=${"a".repeat(2048)}`]) {
		const response = await f.request(`${FEED}?${query}`);
		expect(response.status).toBe(200);
		await response.text();
	}
});

test("LIFE validates exact mutation fields, identifiers, revisions and text", async () => {
	const f = fixture();
	const invalid = [
		null,
		[],
		{},
		{ ...REPLY, actorId: "other" },
		{ ...REPLY, recipientId: "other" },
		{ ...REPLY, requestKey: "a:b" },
		{ ...REPLY, requestKey: "a".repeat(129) },
		{ ...REPLY, expectedPostRevision: -1 },
		{ ...REPLY, expectedPostRevision: 1.5 },
		{ ...REPLY, expectedPostRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...REPLY, expectedPostRevision: "1" },
		{ ...REPLY, text: " " },
		{ ...REPLY, text: 1 },
		{ ...REPLY, text: "a".repeat(32769) },
	];
	for (const body of invalid) {
		const response = await f.json(`${FEED}/posts/post-1/replies`, "POST", body);
		expect(response.status).toBe(400);
		await response.text();
	}
	for (const [suffix, method, body] of [
		[
			"reactions",
			"PUT",
			{
				requestKey: "k",
				expectedPostRevision: 1,
				reactionId: "like",
				active: "true",
			},
		],
		[
			"reactions",
			"PUT",
			{
				requestKey: "k",
				expectedPostRevision: 1,
				reactionId: "like:other",
				active: true,
			},
		],
		[
			"reshares",
			"POST",
			{ requestKey: "k", expectedPostRevision: 1, recipientId: "other" },
		],
	] as const) {
		const response = await f.json(
			`${FEED}/posts/post-1/${suffix}`,
			method,
			body,
		);
		expect(response.status).toBe(400);
		await response.text();
	}
	for (const body of [
		{ expectedRevision: -1, postId: "post-1" },
		{ expectedRevision: 0, postId: null },
		{ expectedRevision: 0, postId: "a/b" },
		{ expectedRevision: 0, postId: "post-1", viewerId: "other" },
	]) {
		const response = await f.json(`${FEED}/cursor`, "PUT", body);
		expect(response.status).toBe(400);
		await response.text();
	}
	expect(f.seen).toHaveLength(0);
	const response = await f.json(
		`${FEED.replace("world-1", "a".repeat(128))}/posts/Post_1.2/replies`,
		"POST",
		{ ...REPLY, requestKey: "a".repeat(128), text: "a".repeat(32768) },
	);
	expect(response.status).toBe(200);
	await response.text();
});

test("LIFE rejects malformed, non-JSON, encoded and oversized request bodies before dispatch", async () => {
	const f = fixture();
	for (const [body, headers, status] of [
		["{", { "Content-Type": "application/json" }, 400],
		[JSON.stringify(REPLY), { "Content-Type": "text/plain" }, 400],
		[
			JSON.stringify(REPLY),
			{ "Content-Type": "application/json", "Content-Encoding": "gzip" },
			400,
		],
		["a".repeat(65537), { "Content-Type": "application/json" }, 413],
	] as const) {
		const response = await f.request(`${FEED}/posts/post-1/replies`, {
			method: "POST",
			body,
			headers,
		});
		expect(response.status).toBe(status);
		security(response);
		await response.text();
	}
	const streamed = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(32768));
			controller.enqueue(new Uint8Array(32769));
			controller.close();
		},
	});
	const response = await f.request(`${FEED}/posts/post-1/replies`, {
		method: "POST",
		body: streamed,
		headers: { "Content-Type": "application/json" },
	});
	expect(response.status).toBe(413);
	await response.text();
	expect(f.seen).toHaveLength(0);
});

test("LIFE never follows upstream redirects or reflects private error bodies and headers", async () => {
	let hits = 0;
	const trap = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			hits++;
			return Response.json({ private: true });
		},
	});
	cleanup.push(() => trap.stop(true));
	let status = 302;
	const f = fixture(
		() =>
			new Response("private source and token", {
				status,
				headers: {
					Location: `http://127.0.0.1:${trap.port}/private`,
					"Set-Cookie": "private=1",
					"X-Private": "private",
				},
			}),
	);
	for (const code of [
		301, 302, 303, 307, 308, 400, 401, 403, 404, 409, 413, 429, 500,
	]) {
		status = code;
		const response = await f.request();
		expect(response.status).toBe(
			code < 400 || code >= 500 ? 502 : code === 401 ? 403 : code,
		);
		expect(await response.text()).not.toContain("private");
		security(response);
	}
	expect(f.seen).toHaveLength(13);
	expect(hits).toBe(0);
});

test("LIFE rejects oversized or non-JSON upstream success and accepts empty success", async () => {
	let mode = 0;
	const f = fixture(
		() =>
			[
				() => Response.json({ text: "a".repeat(2097153) }),
				() =>
					new Response("<script>private</script>", {
						headers: { "Content-Type": "text/html" },
					}),
				() =>
					new Response("{private", {
						headers: { "Content-Type": "application/json" },
					}),
				() => new Response(null, { status: 204 }),
			][mode]?.() ?? Response.json({ posts: [] }),
	);
	for (mode = 0; mode < 4; mode++) {
		const response = await f.request();
		expect(response.status).toBe(mode === 3 ? 204 : 502);
		expect(await response.text()).toBe(
			mode === 3 ? "" : "LIFE service unavailable",
		);
		security(response);
	}
});

test("LIFE same-origin browser GET without Origin requires the scoped bearer and a valid Host", async () => {
	const f = fixture();
	for (const path of [FEED, `${FEED}/cursor`, `${FEED}/posts/post-1`]) {
		const response = await fetch(f.base + path, {
			headers: { Authorization: BEARER, "Sec-Fetch-Site": "same-origin" },
		});
		expect(response.status).toBe(200);
		await response.text();
	}
	expect(f.seen).toHaveLength(3);
	for (const headers of [
		{ Authorization: BEARER, "Sec-Fetch-Site": "cross-site" },
		{ Authorization: BEARER, "Sec-Fetch-Site": "same-site" },
		{
			Authorization: BEARER,
			"Sec-Fetch-Site": "same-origin",
			Host: "evil.example",
		},
		{ "Sec-Fetch-Site": "same-origin" },
	]) {
		const response = await fetch(f.base + FEED, { headers });
		expect(response.status).toBe(403);
		await response.text();
	}
	const write = await fetch(f.base + `${FEED}/posts/post-1/replies`, {
		method: "POST",
		headers: {
			Authorization: BEARER,
			"Sec-Fetch-Site": "same-origin",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(REPLY),
	});
	expect(write.status).toBe(403);
	await write.text();
	expect(f.seen).toHaveLength(3);
});
