import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ima2Client } from "../src/images/client.ts";
import {
	catalog,
	fixture,
	input,
	lane,
	origin,
	png,
	requestId,
	terminal,
} from "./ima2-client-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function serverFile(data?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "lina-ima2-"));
	roots.push(root);
	const path = join(root, "server.json");
	if (data !== undefined) writeFileSync(path, JSON.stringify(data));
	return path;
}

test("server.json discovers backend.url without trusting proxy, port, or admin credentials", async () => {
	const { fetch, requests } = fixture();
	const client = new Ima2Client({
		serverFile: serverFile({
			backend: { url: origin },
			url: "http://127.0.0.1:9",
			adminToken: "private-admin-token",
			oauth: { url: "http://127.0.0.1:8" },
		}),
		fetch,
	});
	expect((await client.connect()).baseUrl).toBe(origin);
	expect(
		requests.every(
			(r) => !r.headers.has("authorization") && !r.headers.has("x-ima2-token"),
		),
	).toBe(true);
});

test("explicit URL wins over absent discovery and absent discovery never probes a default port", async () => {
	const path = serverFile();
	const { fetch, requests } = fixture();
	expect(
		(
			await new Ima2Client({
				baseUrl: origin,
				serverFile: path,
				fetch,
			}).connect()
		).baseUrl,
	).toBe(origin);
	const before = requests.length;
	await expect(
		new Ima2Client({ serverFile: path, fetch }).connect(),
	).rejects.toMatchObject({
		code: "DISCOVERY_UNAVAILABLE",
		outcome: "rejected",
	});
	expect(requests.length).toBe(before);
});

test("discovered endpoint is fixed for client lifetime across reconnect and recovery", async () => {
	const path = serverFile({ backend: { url: origin } });
	const { fetch, requests } = fixture(() =>
		Response.json({ jobs: [], terminalJobs: [terminal()] }),
	);
	const client = new Ima2Client({ serverFile: path, fetch });
	expect((await client.connect()).baseUrl).toBe(origin);
	const changedOrigin = "http://127.0.0.1:43128";
	writeFileSync(path, JSON.stringify({ backend: { url: changedOrigin } }));
	expect((await client.connect()).baseUrl).toBe(origin);
	expect((await client.read(requestId)).state).toBe("completed");
	expect(
		requests.every((request) => new URL(request.url).origin === origin),
	).toBe(true);
	expect(
		(await new Ima2Client({ serverFile: path, fetch }).connect()).baseUrl,
	).toBe(changedOrigin);
});

test("catalog snapshots returned to callers cannot override submission admission", async () => {
	const { client } = fixture();
	const connection = await client.connect();
	connection.lanes[0]?.models.push({
		id: "foreign-model",
		label: "Foreign",
		generate: true,
		edit: true,
	});
	await expect(
		client.submit({ ...input, model: "foreign-model" }),
	).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
});

test("bounded request timeout covers headers and stalled response bodies", async () => {
	for (const phase of ["headers", "body"]) {
		const { client } = fixture(
			() =>
				phase === "headers"
					? new Promise<Response>(() => {})
					: new Response(
							new ReadableStream({
								start(c) {
									c.enqueue(new TextEncoder().encode("{"));
								},
							}),
							{ headers: { "content-type": "application/json" } },
						),
			{ timeoutMs: 20 },
		);
		await client.connect();
		await expect(client.submit(input)).rejects.toMatchObject({
			code: "TIMEOUT",
			outcome: "unknown",
		});
	}
});

test("pre-aborted submit cannot send a request even when connection is cached", async () => {
	const { client, requests } = fixture();
	await client.connect();
	const abort = new AbortController();
	abort.abort("secret reason");
	await expect(client.submit(input, abort.signal)).rejects.toMatchObject({
		code: "ABORTED",
		outcome: "rejected",
	});
	expect(requests).toHaveLength(2);
});

test.each([
	"https://remote.invalid",
	"http://127.0.0.1:43127/path",
	"http://secret@127.0.0.1:43127",
	"file:///etc/passwd",
])("unsafe discovery %s makes no request", async (url) => {
	const { fetch, requests } = fixture();
	await expect(
		new Ima2Client({
			serverFile: serverFile({ backend: { url } }),
			fetch,
		}).connect(),
	).rejects.toMatchObject({ outcome: "rejected" });
	expect(requests).toHaveLength(0);
});

test.each([
	"http://secret@localhost:1",
	"http://localhost:1/path",
	"http://localhost:1/?token=x",
	"http://localhost:1/#x",
	"file:///etc/passwd",
])("invalid explicit origin %s rejected", async (baseUrl) => {
	const { fetch, requests } = fixture();
	await expect(
		new Ima2Client({ baseUrl, fetch }).connect(),
	).rejects.toMatchObject({ code: "INVALID_SERVER_URL" });
	expect(requests).toHaveLength(0);
});

test("version mismatch and malformed catalogs cannot be marked ready", async () => {
	for (const body of [
		{ ok: true, version: "3.13.0" },
		{ ok: true, version: "4.0.0" },
		{ ok: true },
	]) {
		await expect(
			new Ima2Client({
				baseUrl: origin,
				fetch: async () => Response.json(body),
			}).connect(),
		).rejects.toMatchObject({ outcome: "rejected" });
	}
	await expect(
		new Ima2Client({
			baseUrl: origin,
			fetch: async (url) =>
				Response.json(
					url.endsWith("/api/health")
						? { ok: true, version: "3.14.0" }
						: { ok: true, lanes: [] },
				),
		}).connect(),
	).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

test("unknown/MCP and agy lanes cannot silently route to oauth or a forced model", async () => {
	for (const provider of ["higgsfield", "unrecognized", "agy"]) {
		const client = new Ima2Client({
			baseUrl: origin,
			fetch: async (url) =>
				Response.json(
					url.endsWith("/api/health")
						? { ok: true, version: "3.14.0" }
						: { ...catalog, lanes: { [provider]: lane } },
				),
		});
		expect((await client.connect()).lanes[0]?.models[0]?.generate).toBe(false);
		await expect(client.submit({ ...input, provider })).rejects.toMatchObject({
			code: "UNSUPPORTED_OPERATION",
			outcome: "rejected",
		});
	}
});

test("unknown model and auto provider never reach generate", async () => {
	const { client, requests } = fixture();
	await client.connect();
	await expect(
		client.submit({ ...input, model: "missing" }),
	).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
	await expect(
		client.submit({ ...input, provider: "auto" }),
	).rejects.toMatchObject({ outcome: "rejected" });
	expect(requests).toHaveLength(2);
});

test("request identifiers are rejected instead of normalized to a different upstream ID", async () => {
	const { client, requests } = fixture();
	for (const id of ["", "x".repeat(129), "../other", "id\nsecret"]) {
		await expect(
			client.submit({ ...input, requestId: id }),
		).rejects.toMatchObject({ code: "INVALID_INPUT", outcome: "rejected" });
	}
	expect(requests).toHaveLength(0);
});

test("invalid or oversized reference bytes are rejected before network submission", async () => {
	const { client, requests } = fixture();
	for (const bytes of [
		new Uint8Array(),
		new TextEncoder().encode("<html>secret</html>"),
		new Uint8Array(2 * 1024 * 1024 + 1),
	]) {
		await expect(
			client.submit({ ...input, reference: { bytes, mime: "image/png" } }),
		).rejects.toMatchObject({ outcome: "rejected" });
	}
	await expect(
		client.submit({ ...input, reference: { bytes: png, mime: "image/jpeg" } }),
	).rejects.toMatchObject({ code: "INVALID_IMAGE" });
	expect(requests).toHaveLength(0);
});

test.each([
	"../secret.png",
	"http://evil.invalid/image.png",
	"/etc/file.png",
	"%2e%2e.png",
	"x.png?token=secret",
	"image.svg",
	"x\\a.png",
])(
	"unsafe result filename %s is refused without download",
	async (filename) => {
		const { client, requests } = fixture();
		await expect(
			client.download({ requestId, filename }),
		).rejects.toMatchObject({ code: "INVALID_RESULT" });
		expect(requests).toHaveLength(0);
	},
);

test("foreign identities, multiple images, wrong kind, and malformed results fail closed", async () => {
	for (const row of [
		terminal("completed", { filenames: ["a.png", "b.png"] }),
		terminal("completed", { filenames: ["../a.png"] }),
		{ ...terminal(), kind: "video" },
		terminal("completed", {}),
	]) {
		const { client } = fixture(() =>
			Response.json({ jobs: [], terminalJobs: [row] }),
		);
		await expect(client.read(requestId)).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	}
	const { client } = fixture(() =>
		Response.json({ requestId: "other", async: true }, { status: 202 }),
	);
	await client.connect();
	await expect(client.submit(input)).rejects.toMatchObject({
		code: "INVALID_RESPONSE",
		outcome: "unknown",
	});
});

test.each([401, 403, 409, 429, 500, 503])(
	"HTTP %s errors are redacted and classify submission uncertainty",
	async (status) => {
		const { client, requests } = fixture(() =>
			Response.json(
				{
					error: "SECRET provider key https://secret.invalid/?token=private",
					code: "PRIVATE_SECRET",
				},
				{ status },
			),
		);
		await client.connect();
		try {
			await client.submit(input);
			throw new Error("expected failure");
		} catch (error) {
			expect(error).toMatchObject({
				status,
				outcome: status < 500 && status !== 409 ? "rejected" : "unknown",
			});
			expect(String(error)).not.toContain("SECRET");
			expect(JSON.stringify(error)).not.toContain("private");
		}
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	},
);

test("network loss after submit is unknown and is never retried", async () => {
	const { client, requests } = fixture(() => {
		throw new Error("secret provider key");
	});
	await client.connect();
	await expect(client.submit(input)).rejects.toMatchObject({
		code: "NETWORK_ERROR",
		outcome: "unknown",
	});
	expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

test("caller abort stops pending request without issuing upstream cancellation", async () => {
	const started = Promise.withResolvers<void>();
	const { client, requests } = fixture(
		(r) =>
			new Promise((_resolve, reject) => {
				started.resolve();
				r.signal.addEventListener("abort", () => reject(r.signal.reason), {
					once: true,
				});
			}),
	);
	await client.connect();
	const abort = new AbortController();
	const work = client.submit(input, abort.signal);
	await started.promise;
	abort.abort(new Error("private abort reason"));
	await expect(work).rejects.toMatchObject({
		code: "ABORTED",
		outcome: "unknown",
	});
	expect(requests.some((r) => r.method === "DELETE")).toBe(false);
});

test("download refuses redirect, mismatched MIME, invalid container and oversized stream", async () => {
	for (const response of [
		new Response(null, {
			status: 302,
			headers: { location: "https://evil.invalid" },
		}),
		new Response(png, { headers: { "content-type": "image/jpeg" } }),
		new Response("<html>private</html>", {
			headers: { "content-type": "image/png" },
		}),
		new Response(png, {
			headers: { "content-type": "image/png", "content-length": "2097153" },
		}),
	]) {
		const { client } = fixture(() => response);
		await expect(
			client.download({ requestId, filename: "image.png" }),
		).rejects.toBeInstanceOf(Error);
	}
	const { client } = fixture(
		() =>
			new Response(
				new ReadableStream({
					start(c) {
						c.enqueue(png);
						c.enqueue(new Uint8Array(100));
						c.close();
					},
				}),
				{ headers: { "content-type": "image/png" } },
			),
		{ maxImageBytes: 100 },
	);
	await expect(
		client.download({ requestId, filename: "image.png" }),
	).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
});
