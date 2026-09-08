import { afterEach, expect, test } from "bun:test";
import {
	Ima2Client,
	Ima2Error,
	type Ima2SubmissionSnapshot,
} from "../src/images/client.ts";
import { Ima2Http } from "../src/images/client-http.ts";
import {
	closeSubmissionServers,
	submissionServer,
} from "./ima2-before-submit-fixture.ts";
import { fixture, input, origin, png } from "./ima2-client-fixture.ts";

afterEach(closeSubmissionServers);

test("beforeSubmit denies revoked authority after held async catalog preparation with no POST", async () => {
	const server = submissionServer({ holdCatalog: true });
	let allowed = true;
	let checks = 0;
	const work = server.client.submit(input, undefined, () => {
		checks++;
		if (!allowed) throw new Error("private revoked grant");
	});
	await server.preparing.promise;
	expect(checks).toBe(0);
	allowed = false;
	server.release.resolve();
	const result = await work.catch((error: unknown) => error);
	expect(result).toBeInstanceOf(Ima2Error);
	expect(result).toMatchObject({
		code: "SUBMIT_DENIED",
		outcome: "rejected",
		dispatch: "not-dispatched",
	});
	expect(checks).toBe(1);
	expect(
		server.calls.filter(({ init }) => init.method === "POST"),
	).toHaveLength(0);
	expect(server.bodies).toHaveLength(0);
});

test("HTTP beforeSubmit runs after its awaited baseUrl preparation", async () => {
	const preparing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let posts = 0;
	let allowed = true;
	let checks = 0;
	class HeldHttp extends Ima2Http {
		override async baseUrl() {
			preparing.resolve();
			await release.promise;
			return origin;
		}
	}
	const http = new HeldHttp({
		baseUrl: origin,
		fetch: async () => {
			posts++;
			return Response.json({ ok: true });
		},
	});
	const work = http.json(
		"/api/generate",
		{ method: "POST", body: "{}" },
		() => {
			checks++;
			if (!allowed) throw new Error("revoked");
		},
	);
	await preparing.promise;
	expect(checks).toBe(0);
	allowed = false;
	release.resolve();
	await expect(work).rejects.toMatchObject({
		code: "SUBMIT_DENIED",
		dispatch: "not-dispatched",
	});
	expect(checks).toBe(1);
	expect(posts).toBe(0);
});

test("caller mutation during preparation cannot change checked or posted identity/reference bytes", async () => {
	const server = submissionServer({ holdCatalog: true });
	const reference = { bytes: new Uint8Array(png), mime: "image/png" as const };
	const mutable = { ...input, prompt: "나무 🌲", reference };
	let checked: Ima2SubmissionSnapshot | undefined;
	const work = server.client.submit(mutable, undefined, (snapshot) => {
		checked = snapshot;
	});
	await server.preparing.promise;
	mutable.requestId = "changed";
	mutable.provider = "changed";
	mutable.model = "changed";
	mutable.prompt = "private changed prompt";
	reference.bytes.fill(0);
	server.release.resolve();
	expect(await work).toMatchObject({
		requestId: input.requestId,
		state: "queued",
	});
	expect(checked).toBeDefined();
	expect(server.bodies).toHaveLength(1);
	const expected = JSON.stringify({
		...input,
		prompt: "나무 🌲",
		async: true,
		n: 1,
		references: [`data:image/png;base64,${png.toString("base64")}`],
		format: "png",
	});
	expect(server.bodies[0]).toBe(expected);
	expect(checked?.bodyJson).toBe(expected);
	expect(checked?.body).toEqual(JSON.parse(expected));
	expect(checked?.bodyByteLength).toBe(
		new TextEncoder().encode(expected).length,
	);
	expect(checked?.bodySha256).toBe(
		new Bun.CryptoHasher("sha256").update(expected).digest("hex"),
	);
	expect(checked?.reference).toEqual({
		mime: "image/png",
		byteLength: png.length,
		sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
		dataUrl: `data:image/png;base64,${png.toString("base64")}`,
	});
	expect(checked?.url).toBe(`${server.baseUrl}/api/generate`);
	expect(checked?.version).toBe("3.14.0");
	expect(checked?.headers["Idempotency-Key"]).toBe(input.requestId);
});

test("snapshot is deeply immutable and no callback is serialized", async () => {
	const server = submissionServer();
	let checks = 0;
	await server.client.submit(
		{ ...input, reference: { bytes: png, mime: "image/png" } },
		undefined,
		(snapshot) => {
			checks++;
			for (const value of [
				snapshot,
				snapshot.body,
				snapshot.body.references,
				snapshot.headers,
				snapshot.reference,
			])
				expect(Object.isFrozen(value)).toBe(true);
			expect(Reflect.set(snapshot.body, "prompt", "private mutation")).toBe(
				false,
			);
			expect(
				Reflect.set(snapshot.body.references, "0", "private mutation"),
			).toBe(false);
			expect(Reflect.set(snapshot.headers, "Idempotency-Key", "changed")).toBe(
				false,
			);
			expect(Reflect.set(snapshot, "bodyJson", "{}")).toBe(false);
		},
	);
	expect(checks).toBe(1);
	expect(server.bodies[0]).not.toContain("beforeSubmit");
	expect(server.bodies[0]).not.toContain("private mutation");
	expect(JSON.parse(server.bodies[0] ?? "{}")).toEqual({
		...input,
		async: true,
		n: 1,
		references: [`data:image/png;base64,${png.toString("base64")}`],
		format: "png",
	});
});

test("callback in serialized input and multi-reference input remain invalid", async () => {
	const { client, requests } = fixture();
	for (const extra of [{ beforeSubmit: () => {} }, { references: [png, png] }])
		await expect(client.submit({ ...input, ...extra })).rejects.toMatchObject({
			code: "INVALID_INPUT",
			dispatch: "not-dispatched",
		});
	expect(requests).toHaveLength(0);
});

test("cached connection still checks authority and redacts thrown details", async () => {
	const { client, requests } = fixture();
	await client.connect();
	const error = await client
		.submit(input, undefined, () => {
			throw new Ima2Error("ACCESS_DENIED", "private grant and prompt");
		})
		.catch((error: unknown) => error);
	expect(error).toMatchObject({
		code: "SUBMIT_DENIED",
		dispatch: "not-dispatched",
		outcome: "rejected",
	});
	expect(JSON.stringify(error)).not.toContain("private");
	expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});

test("no microtask can revoke authority between the final hook and fetch invocation", async () => {
	let allowed = true;
	const order: string[] = [];
	const base = fixture();
	const client = new Ima2Client({
		baseUrl: origin,
		fetch: (url, init) => {
			if (init.method === "POST") {
				order.push(allowed ? "post-authorized" : "post-revoked");
			}
			return base.fetch(url, init);
		},
	});
	await client.connect();
	await client.submit(input, undefined, () => {
		order.push("guard");
		queueMicrotask(() => {
			allowed = false;
			order.push("revoke");
		});
	});
	expect(order).toEqual(["guard", "post-authorized", "revoke"]);
});
