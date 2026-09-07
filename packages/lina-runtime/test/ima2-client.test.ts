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

test("connect projects actual lanes and never treats catalog readiness as generation proof", async () => {
	const { client, requests } = fixture();
	expect(await client.connect()).toMatchObject({
		baseUrl: origin,
		version: "3.14.0",
		ready: true,
		lanes: [
			{
				provider: "api",
				status: "ready",
				models: [{ id: "image-model", generate: true, edit: true }],
			},
		],
	});
	expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
		"/api/health",
		"/api/models",
	]);
});

test("submit sends ONE async generation with explicit selection and same request/idempotency identity", async () => {
	const { client, requests } = fixture();
	await client.connect();
	expect(await client.submit(input)).toEqual({ requestId, state: "queued" });
	const request = requests.at(-1);
	expect(request?.headers.get("idempotency-key")).toBe(requestId);
	expect(request?.headers.get("x-request-id")).toBe(requestId);
	expect(await request?.json()).toEqual({
		...input,
		async: true,
		n: 1,
		references: [],
		format: "png",
	});
});

test("reference edits transmit provided bytes as one data URL", async () => {
	const { client, requests } = fixture();
	await client.connect();
	await client.submit({
		...input,
		reference: { bytes: png, mime: "image/png" },
	});
	expect(await requests.at(-1)?.json()).toMatchObject({
		references: [`data:image/png;base64,${png.toString("base64")}`],
	});
});

test("a fresh client recovers completed output by the same requestId without a POST", async () => {
	const { client, requests } = fixture(() =>
		Response.json({ jobs: [], terminalJobs: [terminal()] }),
	);
	expect(await client.read(requestId)).toEqual({
		requestId,
		state: "completed",
		result: { requestId, filename: "image.png" },
	});
	expect(requests.every((r) => r.method === "GET")).toBe(true);
	expect(requests.at(-1)?.url).toBe(`${origin}/api/inflight?includeTerminal=1`);
});

test.each([
	["queued", "queued"],
	["streaming", "running"],
	["decoding", "post_processing"],
	["new-upstream-phase", "unknown"],
] as const)("active phase %s is %s", async (phase, state) => {
	const { client } = fixture(() =>
		Response.json({
			jobs: [{ requestId, kind: "classic", phase }],
			terminalJobs: [],
		}),
	);
	expect((await client.read(requestId)).state).toBe(state);
});

test.each([
	["failed", "failed"],
	["error", "failed"],
	["canceled", "cancelled"],
	["cancelled", "cancelled"],
	["unexpected", "unknown"],
] as const)(
	"terminal status %s is %s without fabricating a result",
	async (status, state) => {
		const { client } = fixture(() =>
			Response.json({ jobs: [], terminalJobs: [terminal(status, {})] }),
		);
		const job = await client.read(requestId);
		expect(job.state).toBe(state);
		expect(job.result).toBeUndefined();
	},
);

test("tracking timeout is terminal uncertainty, never cancellation or automatic retry", async () => {
	const { client } = fixture(() =>
		Response.json({
			jobs: [],
			terminalJobs: [
				{
					...terminal("error", {}),
					errorCode: "JOB_TRACKING_TIMEOUT",
					httpStatus: 504,
				},
			],
		}),
	);
	expect(await client.read(requestId)).toMatchObject({
		requestId,
		state: "timed_out",
		error: { code: "JOB_TRACKING_TIMEOUT" },
	});
});

test("expired terminal record is recovered only from matching history", async () => {
	const { client, requests } = fixture((r) =>
		Response.json(
			new URL(r.url).pathname === "/api/inflight"
				? { jobs: [], terminalJobs: [] }
				: { items: [{ requestId, filename: "image.png" }], nextCursor: null },
		),
	);
	expect((await client.read(requestId)).result).toEqual({
		requestId,
		filename: "image.png",
	});
	expect(requests.at(-1)?.url).toBe(
		`${origin}/api/history?requestId=${requestId}&limit=2`,
	);
});

test("missing records remain unknown with no resubmission", async () => {
	const { client, requests } = fixture((r) =>
		Response.json(
			new URL(r.url).pathname === "/api/inflight"
				? { jobs: [], terminalJobs: [] }
				: { items: [], nextCursor: null },
		),
	);
	expect(await client.read(requestId)).toEqual({ requestId, state: "unknown" });
	expect(requests.every((r) => r.method === "GET")).toBe(true);
});

test.each([
	{ active: true, aborted: true },
	{ active: false, aborted: false },
	{ active: true, aborted: false },
])("cancel preserves registry acknowledgement %j", async (ack) => {
	const { client, requests } = fixture(() =>
		Response.json({ requestId, ...ack }),
	);
	expect(await client.cancel(requestId)).toEqual({ requestId, ...ack });
	expect(requests.at(-1)?.method).toBe("DELETE");
	expect(requests.at(-1)?.url).toBe(`${origin}/api/inflight/${requestId}`);
});

test("download uses only generated filename on configured origin", async () => {
	const { client, requests } = fixture(
		() => new Response(png, { headers: { "Content-Type": "image/png" } }),
	);
	const result = await client.download({ requestId, filename: "image.png" });
	expect(result.mime).toBe("image/png");
	expect(result.bytes).toEqual(new Uint8Array(png));
	expect(requests.at(-1)?.url).toBe(`${origin}/generated/image.png`);
});

test("upstream filenames retain model dots, Unicode prompt slugs and encoded punctuation", async () => {
	// lib/filename.ts preserves dots and CJK/emoji in its prompt slug.
	const filename = "gpt-5.5_1x1_20260907_나무🌲-(초록)_0.png";
	const { client, requests } = fixture(
		() => new Response(png, { headers: { "Content-Type": "image/png" } }),
	);
	expect((await client.download({ requestId, filename })).mime).toBe(
		"image/png",
	);
	expect(requests.at(-1)?.url).toBe(
		`${origin}/generated/${encodeURIComponent(filename)}`,
	);
});

test("idempotent terminal replay accepts exact same request identity", async () => {
	const { client } = fixture(() =>
		Response.json({
			requestId,
			filename: "image.png",
			image: "data:image/png;base64,ignored",
			provider: "api",
			model: "image-model",
			idempotentReplay: true,
		}),
	);
	await client.connect();
	expect((await client.submit(input)).result).toEqual({
		requestId,
		filename: "image.png",
	});
});

test.each(["key-missing", "disconnected", "locked"])(
	"unready lane %s is visible but cannot submit",
	async (status) => {
		const requests: string[] = [];
		const client = new Ima2Client({
			baseUrl: origin,
			fetch: async (url) => {
				requests.push(url);
				return Response.json(
					url.endsWith("/api/health")
						? { ok: true, version: "3.14.0" }
						: { ...catalog, lanes: { api: { ...lane, status } } },
				);
			},
		});
		expect((await client.connect()).ready).toBe(false);
		await expect(client.submit(input)).rejects.toMatchObject({
			code: "LANE_UNAVAILABLE",
		});
		expect(requests.some((url) => url.endsWith("/api/generate"))).toBe(false);
	},
);
