import { expect, test } from "bun:test";
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

test("generated JPEG bytes are downloadable and usable for a reference edit", async () => {
	// Existing Lina JPEG fixture (attachment-document-tool.test.ts).
	const jpeg = Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
		"base64",
	);
	const { client, requests } = fixture((request) =>
		request.method === "POST"
			? Response.json({ requestId, async: true }, { status: 202 })
			: new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
	);
	const image = await client.download({ requestId, filename: "result.jpg" });
	expect(image).toEqual({ bytes: new Uint8Array(jpeg), mime: "image/jpeg" });
	await client.submit({ ...input, reference: image });
	expect(await requests.at(-1)?.json()).toMatchObject({
		references: [`data:image/jpeg;base64,${jpeg.toString("base64")}`],
	});
});

test("a model without reference support rejects edit without a POST", async () => {
	let posts = 0;
	const client = new Ima2Client({
		baseUrl: origin,
		fetch: async (url, init) => {
			if (init.method === "POST") posts++;
			return Response.json(
				url.endsWith("/api/health")
					? { ok: true, version: "3.14.0" }
					: {
							...catalog,
							lanes: {
								api: {
									...lane,
									surfaces: {
										generate: { supported: true, references: false },
									},
								},
							},
						},
			);
		},
	});
	await expect(
		client.submit({ ...input, reference: { bytes: png, mime: "image/png" } }),
	).rejects.toMatchObject({
		code: "UNSUPPORTED_OPERATION",
		outcome: "rejected",
	});
	expect(posts).toBe(0);
});

test("foreign, duplicate, or paginated history cannot become this request's result", async () => {
	for (const page of [
		{ items: [{ requestId: "other-request", filename: "other.png" }] },
		{
			items: [
				{ requestId, filename: "one.png" },
				{ requestId, filename: "two.png" },
			],
		},
		{ items: [{ requestId, filename: "one.png" }], nextCursor: "more" },
	]) {
		const { client } = fixture((r) =>
			Response.json(
				new URL(r.url).pathname === "/api/inflight"
					? { jobs: [], terminalJobs: [] }
					: page,
			),
		);
		await expect(client.read(requestId)).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
		});
	}
});

test("malformed success JSON, unexpected HTTP status and provider switches are uncertain submissions", async () => {
	for (const response of [
		new Response("{private", {
			headers: { "content-type": "application/json" },
		}),
		new Response("private", { headers: { "content-type": "text/html" } }),
		Response.json({ requestId, async: true }, { status: 201 }),
		Response.json({
			requestId,
			idempotentReplay: true,
			filename: "x.png",
			provider: "oauth",
			model: input.model,
		}),
	]) {
		const { client } = fixture(() => response);
		await client.connect();
		await expect(client.submit(input)).rejects.toMatchObject({
			code: "INVALID_RESPONSE",
			outcome: "unknown",
		});
	}
});

test("malformed cancellation identity cannot be reported as acknowledged", async () => {
	const { client } = fixture(() =>
		Response.json({ requestId: "other", active: true, aborted: true }),
	);
	await expect(client.cancel(requestId)).rejects.toMatchObject({
		code: "INVALID_RESPONSE",
		outcome: "unknown",
	});
});

test("JSON byte limit terminates oversized bodies without echoing their contents", async () => {
	const { client } = fixture(
		() =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
						controller.close();
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	await client.connect();
	await expect(client.submit(input)).rejects.toMatchObject({
		code: "BODY_TOO_LARGE",
		outcome: "unknown",
	});
});

test("JSON and downloads use manual redirects with omitted credentials", async () => {
	const calls: RequestInit[] = [];
	const base = fixture();
	const client = new Ima2Client({
		baseUrl: origin,
		fetch: async (url, init) => {
			calls.push(init);
			return base.fetch(url, init);
		},
	});
	await client.connect();
	await client.submit(input);
	for (const call of calls)
		expect(call).toMatchObject({ redirect: "manual", credentials: "omit" });
});

test("terminal success spelling variants retain result identity", async () => {
	for (const status of ["done", "complete"]) {
		const { client } = fixture(() =>
			Response.json({ jobs: [], terminalJobs: [terminal(status)] }),
		);
		expect((await client.read(requestId)).result).toEqual({
			requestId,
			filename: "image.png",
		});
	}
});

test("409 idempotency collision remains unknown and can recover the existing job", async () => {
	const { client, requests } = fixture((request) =>
		request.method === "POST"
			? Response.json(
					{
						code: "IDEMPOTENCY_KEY_CONFLICT",
						requestId,
						error: "private details",
					},
					{ status: 409 },
				)
			: Response.json({ jobs: [], terminalJobs: [terminal()] }),
	);
	await client.connect();
	await expect(client.submit(input)).rejects.toMatchObject({
		code: "CONFLICT",
		outcome: "unknown",
		status: 409,
	});
	expect(await client.read(requestId)).toEqual({
		requestId,
		state: "completed",
		result: { requestId, filename: "image.png" },
	});
	expect(requests.filter((request) => request.method === "POST")).toHaveLength(
		1,
	);
});

test("unknown-kind cancellation tombstone does not confirm a generation was cancelled", async () => {
	const { client, requests } = fixture((request) =>
		Response.json(
			new URL(request.url).pathname === "/api/inflight"
				? {
						jobs: [],
						terminalJobs: [{ ...terminal("canceled", {}), kind: "unknown" }],
					}
				: { items: [], nextCursor: null },
		),
	);
	expect(await client.read(requestId)).toEqual({ requestId, state: "unknown" });
	expect(requests.at(-1)?.url).toBe(
		`${origin}/api/history?requestId=${requestId}&limit=2`,
	);
});

test("matching history proves completed after restart despite an unknown cancellation tombstone", async () => {
	const { client, requests } = fixture((request) =>
		Response.json(
			new URL(request.url).pathname === "/api/inflight"
				? {
						jobs: [],
						terminalJobs: [{ ...terminal("canceled", {}), kind: "unknown" }],
					}
				: {
						items: [{ requestId, filename: "recovered.png" }],
						nextCursor: null,
					},
		),
	);
	expect(await client.read(requestId)).toEqual({
		requestId,
		state: "completed",
		result: { requestId, filename: "recovered.png" },
	});
	expect(requests.every((request) => request.method === "GET")).toBe(true);
});

test("unexpected raw failure details never enter normalized terminal jobs", async () => {
	const { client } = fixture(() =>
		Response.json({
			jobs: [],
			terminalJobs: [
				{
					...terminal("failed", {
						prompt: "private prompt",
						credential: "secret credential",
					}),
					errorCode: "SECRET_CREDENTIAL",
					error: "private response",
				},
			],
		}),
	);
	const result = JSON.stringify(await client.read(requestId));
	expect(result).not.toContain("private");
	expect(result).not.toContain("SECRET_CREDENTIAL");
	expect(result).not.toContain("secret credential");
});

test("unknown input and output URL fields do not open alternative execution or download surfaces", async () => {
	const { client, requests } = fixture();
	await expect(
		client.submit({ ...input, ...{ providerUrl: "https://foreign.invalid" } }),
	).rejects.toMatchObject({ code: "INVALID_INPUT" });
	await expect(
		client.download({
			requestId,
			filename: "image.png",
			...{ url: "https://foreign.invalid/image.png" },
		}),
	).rejects.toMatchObject({ code: "INVALID_RESULT" });
	expect(requests).toHaveLength(0);
});
