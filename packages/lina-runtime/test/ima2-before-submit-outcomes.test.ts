import { afterEach, expect, test } from "bun:test";
import { type Ima2BeforeSubmit, Ima2Error } from "../src/images/client.ts";
import {
	closeSubmissionServers,
	submissionServer,
} from "./ima2-before-submit-fixture.ts";
import { fixture, input } from "./ima2-client-fixture.ts";

afterEach(closeSubmissionServers);

test.each(["before", "preparation", "guard"] as const)(
	"abort at %s prevents generation fetch",
	async (phase) => {
		const server = submissionServer({ holdCatalog: phase === "preparation" });
		const abort = new AbortController();
		let checks = 0;
		if (phase === "before") abort.abort();
		const work = server.client.submit(input, abort.signal, () => {
			checks++;
			if (phase === "guard") abort.abort("private reason");
		});
		if (phase === "preparation") {
			await server.preparing.promise;
			abort.abort();
			server.release.resolve();
		}
		await expect(work).rejects.toMatchObject({
			code: "ABORTED",
			outcome: "rejected",
			dispatch: "not-dispatched",
		});
		expect(checks).toBe(phase === "guard" ? 1 : 0);
		expect(
			server.calls.filter(({ init }) => init.method === "POST"),
		).toHaveLength(0);
		expect(server.bodies).toHaveLength(0);
	},
);

test.each([401, 403, 409, 429, 500, 503])(
	"HTTP %s after dispatch cannot prove zero attempts",
	async (status) => {
		const server = submissionServer({
			generate: () => Response.json({ error: "private" }, { status }),
		});
		let checks = 0;
		await expect(
			server.client.submit(input, undefined, () => {
				checks++;
			}),
		).rejects.toMatchObject({
			status,
			outcome: status < 500 && status !== 409 ? "rejected" : "unknown",
			dispatch: "dispatched",
		});
		expect(checks).toBe(1);
		expect(server.bodies).toHaveLength(1);
	},
);

test.each(["network", "json", "identity", "redirect"] as const)(
	"%s failure after fetch remains dispatched and unknown",
	async (failure) => {
		const { client, requests } = fixture(() => {
			if (failure === "network") throw new Error("private transport error");
			if (failure === "json")
				return new Response("{", {
					headers: { "content-type": "application/json" },
				});
			if (failure === "redirect")
				return new Response(null, {
					status: 302,
					headers: { location: "https://foreign.invalid" },
				});
			return Response.json(
				{ requestId: "foreign", async: true },
				{ status: 202 },
			);
		});
		await expect(
			client.submit(input, undefined, () => {}),
		).rejects.toMatchObject({
			outcome: "unknown",
			dispatch: "dispatched",
		});
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
	},
);

test("abort after fetch invocation is dispatched uncertainty", async () => {
	const started = Promise.withResolvers<void>();
	const { client, requests } = fixture(() => {
		started.resolve();
		return new Promise<Response>(() => {});
	});
	const abort = new AbortController();
	const work = client.submit(input, abort.signal, () => {});
	await started.promise;
	abort.abort();
	await expect(work).rejects.toMatchObject({
		code: "ABORTED",
		outcome: "unknown",
		dispatch: "dispatched",
	});
	expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
});

test("async authority callbacks fail closed without POST or leaked rejection", async () => {
	const finished = Promise.withResolvers<void>();
	const { client, requests } = fixture();
	// Deliberately cross the untyped caller boundary; the public type disallows Promise returns.
	const asyncHook = async () => {
		await Promise.resolve();
		finished.resolve();
		throw new Error("private asynchronous rejection");
	};
	// @ts-expect-error An authority callback must complete synchronously.
	const hook: Ima2BeforeSubmit = asyncHook;
	await expect(client.submit(input, undefined, hook)).rejects.toMatchObject({
		code: "SUBMIT_DENIED",
		outcome: "rejected",
		dispatch: "not-dispatched",
	});
	await finished.promise;
	expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
});

test.each([false, true, null, "allow", Promise.resolve(undefined)])(
	"non-undefined callback result is never an authorization grant",
	async (result) => {
		const { client, requests } = fixture();
		// @ts-expect-error Runtime callers must fail closed even without TypeScript.
		const hook: Ima2BeforeSubmit = () => result;
		await expect(client.submit(input, undefined, hook)).rejects.toMatchObject({
			code: "SUBMIT_DENIED",
			dispatch: "not-dispatched",
		});
		expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
	},
);

test("generic Ima2Error construction never fabricates no-POST evidence", () => {
	expect(new Ima2Error("HTTP_ERROR", "safe").dispatch).toBe("unknown");
});
