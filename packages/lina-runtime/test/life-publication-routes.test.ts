import { afterEach, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PublicationRunInput } from "../../lina-core/src/world/publication-types.ts";
import { WorldStore } from "../../lina-core/src/world/store.ts";
import {
	preparedPublicationFixture,
	publicationAuthor,
} from "../../lina-core/test/life-publication-prepared-fixture.ts";
import { worldDefinition } from "../../lina-core/test/world-fixture.ts";
import { lifePublicationRoutes } from "../src/fleet/life-publication-routes.ts";
import { ModelRequestError } from "../src/models/errors.ts";

const base = "/api/life/worlds/test-world";
test("publication reports a repairable model configuration error", async () => {
	const f = fixture();
	f.services.run.mockImplementation(async () => {
		throw new ModelRequestError("private routing diagnostic", "not_configured");
	});
	const response = await f.api("/publication/run", "POST", {
		requestKey: "missing-model",
		expectedConfigRevision: 1,
		expectedSettingsRevision: 1,
	});
	expect(response.status).toBe(409);
	expect(await jsonObject(response)).toEqual({
		error: "공통 모델 등급 설정을 확인해주세요.",
		code: "MODEL_NOT_CONFIGURED",
	});
});
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function jsonObject(
	message: Request | Response,
): Promise<Record<string, unknown>> {
	const value: unknown = await message.json();
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("Expected JSON object");
	return { ...value };
}

/** A TCP socket preserves the request-target spelling until Bun receives it. */
function rawGet(
	url: string,
	path: string,
	headers: Record<string, string>,
): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = connect({
			host: "127.0.0.1",
			port: Number(new URL(url).port),
		});
		let response = "";
		socket.setEncoding("utf8");
		socket.once("connect", () => {
			socket.write(
				[
					`GET ${path} HTTP/1.1`,
					...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
					"Connection: close",
					"",
					"",
				].join("\r\n"),
			);
		});
		socket.on("data", (chunk) => {
			response += chunk;
		});
		socket.once("error", reject);
		socket.once("close", () => {
			const status = /^HTTP\/1\.1 (\d{3}) /.exec(response)?.[1];
			if (!status) reject(Error("Missing synthetic HTTP response status"));
			else resolve(Number(status));
		});
	});
}

function fixture(publish = true) {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-http-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "world.sqlite");
	const f = preparedPublicationFixture(path);
	let store = f.store;
	cleanups.push(() => store.close());
	let postId = "missing";
	if (publish) {
		const claimId = f.job.material?.allowedClaims[0]?.id;
		if (!claimId) throw Error("Missing synthetic public claim");
		store.dispatchPublicationModel(
			f.lease,
			f.run.id,
			f.job.id,
			f.prepared.request.id,
		);
		store.finishPublicationModel(
			"test-world",
			f.job.id,
			f.prepared.request.id,
			{
				status: "completed",
				result: {
					version: 1,
					requestId: f.prepared.request.id,
					inputDigest: f.prepared.inputDigest,
					capabilityFingerprint: f.prepared.capabilityFingerprint,
					nativeReference: f.prepared.nativeReference,
					provider: "synthetic",
					model: "narrator",
					threadId: "http-thread",
					turnId: "http-turn",
					text: JSON.stringify({
						kind: "post",
						segments: [{ kind: "claim", claimId }],
					}),
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
					upstreamAttempts: 1,
				},
			},
		);
		const post = store.completePublicationJob(f.lease, f.run.id, f.job.id, {
			author: publicationAuthor,
			modelSettingsRevision: 1,
		});
		if (!post.postId) throw Error("Missing synthetic publication post");
		postId = post.postId;
	}
	const issued = store.mintPublicationViewer("test-world", {
		requestKey: "http-viewer",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	});
	if (!issued.token) throw Error("Missing synthetic viewer token");
	const bearer = `Bearer ${issued.token}`;
	const services = {
		store: mock(() => store),
		changed: mock((_worldId: string): void => {}),
		run: mock(
			async (
				_world: string,
				_input: PublicationRunInput,
				_signal: AbortSignal,
			) => f.run,
		),
	};
	const observedPaths: Array<string | null> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			try {
				observedPaths.push(new URL(request.url).pathname);
			} catch {
				observedPaths.push(null);
			}
			return (
				(await lifePublicationRoutes(request, services, () =>
					jsonObject(request),
				)) ?? new Response(null, { status: 404 })
			);
		},
		error() {
			return new Response("Unexpected synthetic handler failure", {
				status: 500,
			});
		},
	});
	cleanups.push(() => server.stop(true));
	const url = (suffix: string) =>
		`http://127.0.0.1:${server.port}${base}${suffix}`;
	return {
		...f,
		get store() {
			return store;
		},
		services,
		observedPaths,
		bearer,
		grant: issued.grant,
		postId,
		url,
		api: (
			suffix: string,
			method = "GET",
			body?: unknown,
			headers: Record<string, string> = {},
		) =>
			fetch(url(suffix), {
				method,
				headers: {
					authorization: bearer,
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...headers,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		reopen() {
			store.close();
			store = new WorldStore(path, () => 1000);
			return store;
		},
		digest() {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				const hash = createHash("sha256");
				for (const row of db
					.prepare(
						"SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
					)
					.all()) {
					const name = String(row["name"]);
					if (!/^[a-zA-Z0-9_]+$/.test(name))
						throw Error("Invalid synthetic table name");
					hash.update(
						JSON.stringify(
							db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(),
						),
					);
				}
				return hash.digest("hex");
			} finally {
				db.close();
			}
		},
	};
}

test("HTTP feed/detail/cursor reads preserve every stored table and expose only public content across reopen", async () => {
	const f = fixture(),
		before = f.digest();
	for (let i = 0; i < 2; i++) {
		const response = await f.api("/feed?limit=1");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await response.json()).toEqual({
			items: [
				{
					id: f.postId,
					revision: 1,
					kind: "post",
					author: { kind: "agent", agentId: "lina", name: "Lina" },
					reactions: [],
					segments: [
						{
							kind: "claim",
							claimKind: "world_event",
							text: "A bell rang during the meeting",
						},
					],
					createdAt: 1000,
				},
			],
			nextCursor: null,
		});
		expect(
			(await jsonObject(await f.api(`/feed/posts/${f.postId}`)))["id"],
		).toBe(f.postId);
		expect(await (await f.api("/feed/cursor")).json()).toEqual({
			revision: 0,
			postId: null,
		});
		expect((await f.api("/feed/posts/absent")).status).toBe(404);
		f.reopen();
	}
	expect(f.digest()).toBe(before);
	expect(f.services.run).not.toHaveBeenCalled();
	expect(f.services.changed).not.toHaveBeenCalled();
});

test("HTTP cursor CAS persists without LIFE inputs and withdrawal hides detail and cursor target", async () => {
	const f = fixture(),
		inputs = f.store.lifeInputs("test-world");
	const body = { expectedRevision: 0, postId: f.postId };
	expect(await (await f.api("/feed/cursor", "PUT", body)).json()).toEqual({
		revision: 1,
		postId: f.postId,
	});
	expect((await f.api("/feed/cursor", "PUT", body)).status).toBe(409);
	expect(
		(
			await f.api("/feed/cursor", "PUT", {
				expectedRevision: 1,
				postId: "absent",
			})
		).status,
	).toBe(404);
	expect(f.store.lifeInputs("test-world")).toEqual(inputs);
	f.reopen();
	expect(await (await f.api("/feed/cursor")).json()).toEqual({
		revision: 1,
		postId: f.postId,
	});
	const withdrawal = { requestKey: "http-withdraw", expectedRevision: 1 };
	expect(
		(await f.api(`/publication/posts/${f.postId}/withdraw`, "POST", withdrawal))
			.status,
	).toBe(200);
	expect(
		(await f.api(`/publication/posts/${f.postId}/withdraw`, "POST", withdrawal))
			.status,
	).toBe(200);
	f.reopen();
	expect((await f.api(`/feed/posts/${f.postId}`)).status).toBe(404);
	expect(await (await f.api("/feed/cursor")).json()).toEqual({
		revision: 1,
		postId: null,
	});
	expect(await (await f.api("/feed")).json()).toEqual({
		items: [],
		nextCursor: null,
	});
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP mint returns a token once; forged, foreign-world and revoked tokens cannot read", async () => {
	const f = fixture();
	f.store.create(worldDefinition("other-world"));
	const body = {
		requestKey: "http-mint",
		expectedSettingsRevision: 1,
		recipientId: "friends",
	};
	const issued = await jsonObject(
		await f.api("/publication/viewers", "POST", body),
	);
	expect(typeof issued["token"]).toBe("string");
	expect(issued["replayed"]).toBe(false);
	expect(
		await (await f.api("/publication/viewers", "POST", body)).json(),
	).toEqual({ grant: issued["grant"], token: null, replayed: true });
	for (const token of [
		"",
		`Bearer llv1_${"A".repeat(43)}`,
		`Bearer ${f.grant.id}`,
		f.bearer.replace("Bearer", "bearer"),
		`${f.bearer}, ${f.bearer}`,
	]) {
		expect(
			(await f.api("/feed", "GET", undefined, { authorization: token })).status,
		).toBe(403);
	}
	expect(
		(
			await fetch(f.url("/feed").replace("test-world", "other-world"), {
				headers: { authorization: f.bearer },
			})
		).status,
	).toBe(403);
	const revoke = { requestKey: "http-revoke", expectedRevision: 1 };
	expect(
		(await f.api(`/publication/viewers/${f.grant.id}/revoke`, "POST", revoke))
			.status,
	).toBe(200);
	expect(
		(await f.api(`/publication/viewers/${f.grant.id}/revoke`, "POST", revoke))
			.status,
	).toBe(200);
	f.reopen();
	for (const suffix of ["/feed", "/feed/cursor", `/feed/posts/${f.postId}`])
		expect((await f.api(suffix)).status).toBe(403);
	expect(
		(
			await f.api("/feed/cursor", "PUT", {
				expectedRevision: 0,
				postId: f.postId,
			})
		).status,
	).toBe(403);
});

test("HTTP settings require exact fields and CAS and management does not require a viewer token", async () => {
	const f = fixture();
	const response = await f.api("/publication/settings", "GET", undefined, {
		authorization: "",
	});
	expect(response.status).toBe(200);
	const { revision, worldId: _world, ...settings } = await jsonObject(response);
	expect(revision).toBe(1);
	const body = {
		expectedRevision: revision,
		settings: { ...settings, maxJobsPerRun: 2 },
	};
	expect((await f.api("/publication/settings", "PUT", body)).status).toBe(200);
	expect((await f.api("/publication/settings", "PUT", body)).status).toBe(409);
	for (const invalid of [
		{ ...body, mode: "automatic" },
		{ ...body, settings: { ...settings, model: "injected" } },
		{ ...body, settings: { ...settings, maxJobsPerRun: -1 } },
	])
		expect((await f.api("/publication/settings", "PUT", invalid)).status).toBe(
			400,
		);
	f.reopen();
	expect(
		(await jsonObject(await f.api("/publication/settings")))["maxJobsPerRun"],
	).toBe(2);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("management HTTP rejects browser Origin and mismatched actual Host before storage access", async () => {
	const f = fixture();
	for (const suffix of ["/publication/settings", "/feed"]) {
		for (const headers of [
			{ origin: "http://foreign.example" },
			{ origin: `http://127.0.0.1:${new URL(f.url("")).port}` },
			{ origin: "null" },
			{ host: "foreign.example" },
		]) {
			expect((await f.api(suffix, "GET", undefined, headers)).status).toBe(403);
		}
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

test("body await finishes before the storage owner and viewer authority are resolved", async () => {
	const f = fixture();
	const entered = Promise.withResolvers<void>(),
		body = Promise.withResolvers<Record<string, unknown>>();
	const request = new Request(f.url("/feed/cursor"), {
		method: "PUT",
		headers: {
			host: new URL(f.url("")).host,
			authorization: f.bearer,
			"content-type": "application/json",
		},
	});
	const pending = lifePublicationRoutes(request, f.services, () => {
		entered.resolve();
		return body.promise;
	});
	await entered.promise;
	expect(f.services.store).not.toHaveBeenCalled();
	f.store.revokePublicationViewer("test-world", f.grant.id, {
		requestKey: "during-json",
		expectedRevision: 1,
	});
	body.resolve({ expectedRevision: 0, postId: f.postId });
	expect((await pending)?.status).toBe(403);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("manual run forwards only the parsed contract and request abort signal; reads never run", async () => {
	const f = fixture();
	const body = {
		requestKey: "manual-http",
		expectedConfigRevision: 1,
		expectedSettingsRevision: 1,
	};
	const controller = new AbortController();
	const request = new Request(f.url("/publication/run"), {
		method: "POST",
		headers: {
			host: new URL(f.url("")).host,
			"content-type": "application/json",
		},
		signal: controller.signal,
	});
	expect(
		(await lifePublicationRoutes(request, f.services, async () => body))
			?.status,
	).toBe(200);
	expect(f.services.run).toHaveBeenCalledWith(
		"test-world",
		{ ...body, mode: "manual" },
		request.signal,
	);
	controller.abort();
	expect(f.services.run.mock.calls[0]?.[2].aborted).toBe(true);
	expect(f.services.store).not.toHaveBeenCalled();
	expect(
		(await f.api("/publication/run", "POST", { ...body, mode: "automatic" }))
			.status,
	).toBe(400);
	expect((await f.api(`/publication/jobs/${f.job.id}`)).status).toBe(200);
	expect((await f.api("/publication/jobs/absent")).status).toBe(404);
	expect(f.services.run).toHaveBeenCalledTimes(1);
});

test("explicit job retry rejects unknown dispatch and accepts a known failed synthetic attempt", async () => {
	const f = fixture(false);
	let job = f.store.publicationJob("test-world", f.job.id);
	expect(
		(
			await f.api(`/publication/jobs/${f.job.id}/retry`, "POST", {
				requestKey: "uncertain",
				expectedRevision: job.revision,
			})
		).status,
	).toBe(409);
	f.store.dispatchPublicationModel(
		f.lease,
		f.run.id,
		f.job.id,
		f.prepared.request.id,
	);
	f.store.finishPublicationModel(
		"test-world",
		f.job.id,
		f.prepared.request.id,
		{
			status: "failed",
			reason: "synthetic",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			upstreamAttempts: 0,
		},
	);
	job = f.store.publicationJob("test-world", f.job.id);
	const body = { requestKey: "known-retry", expectedRevision: job.revision };
	expect(
		(await f.api(`/publication/jobs/${f.job.id}/retry`, "POST", body)).status,
	).toBe(409);
	f.store.advancePublicationRun(f.lease, f.run.id, f.job.id);
	expect(f.services.changed).not.toHaveBeenCalled();
	const response = await f.api(
		`/publication/jobs/${f.job.id}/retry`,
		"POST",
		body,
	);
	expect(response.status).toBe(200);
	expect((await jsonObject(response))["status"]).toBe("pending");
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	expect(
		(await f.api(`/publication/jobs/${f.job.id}/retry`, "POST", body)).status,
	).toBe(200);
	expect(f.services.run).not.toHaveBeenCalled();
	expect(f.services.changed).toHaveBeenCalledTimes(1);
});

test("structural, query, method and body guards never open storage or invoke JSON for invalid ingress", async () => {
	const services = {
		store: mock((): WorldStore => {
			throw Error("must not open");
		}),
		run: mock(async (): Promise<never> => {
			throw Error("must not run");
		}),
	};
	const json = mock(async () => ({}));
	const cases: Array<[string, string, Record<string, string>, number]> = [
		["/publication/settings/", "GET", {}, 404],
		["/feed//cursor", "GET", {}, 404],
		["/feed/posts/a%2Fb", "GET", {}, 404],
		["/feed/posts/a%5Cb", "GET", {}, 404],
		["/feed/posts/a/extra", "GET", {}, 404],
		[`/feed/posts/${"a".repeat(129)}`, "GET", {}, 404],
		["/publication/settings", "POST", {}, 405],
		["/feed", "PUT", {}, 405],
		["/feed?principal=agent", "GET", {}, 400],
		["/feed?recipientId=friends", "GET", {}, 400],
		["/feed?limit=0", "GET", {}, 400],
		["/feed?limit=101", "GET", {}, 400],
		["/feed?limit=01", "GET", {}, 400],
		["/feed?limit=1&limit=2", "GET", {}, 400],
		["/feed?%6cimit=1", "GET", {}, 400],
		["/feed?after=", "GET", {}, 400],
		[`/feed?after=${"a".repeat(2049)}`, "GET", {}, 400],
		[`/feed?after=llv1_${"A".repeat(43)}`, "GET", {}, 400],
		["/feed/cursor?limit=1", "GET", {}, 400],
		["/publication/settings?token=secret", "GET", {}, 400],
		["/feed", "GET", { "content-length": "1" }, 400],
		["/feed", "GET", { "content-encoding": "gzip" }, 400],
		["/publication/run", "POST", { "content-type": "text/plain" }, 400],
		[
			"/publication/run",
			"POST",
			{ "content-type": "application/json", "content-length": "1000001" },
			400,
		],
		[
			"/publication/run",
			"POST",
			{ "content-type": "application/json", "content-length": "-1" },
			400,
		],
		[
			"/publication/run",
			"POST",
			{ "content-type": "application/json", "content-encoding": "identity" },
			400,
		],
	];
	for (const [suffix, method, headers, status] of cases) {
		const request = new Request(`http://127.0.0.1:8123${base}${suffix}`, {
			method,
			headers: {
				host: "127.0.0.1:8123",
				authorization: `Bearer llv1_${"B".repeat(43)}`,
				...headers,
			},
		});
		const response = await lifePublicationRoutes(request, services, json);
		expect({ suffix, status: response?.status }).toEqual({ suffix, status });
		expect(response?.headers.get("cache-control")).toBe("no-store");
	}
	expect(json).not.toHaveBeenCalled();
	expect(services.store).not.toHaveBeenCalled();
	expect(services.run).not.toHaveBeenCalled();
});

test("unrelated LIFE routes remain unhandled", async () => {
	const f = fixture();
	for (const suffix of ["/status"]) {
		expect(
			await lifePublicationRoutes(
				new Request(f.url(suffix)),
				f.services,
				async () => ({}),
			),
		).toBeUndefined();
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP rejects principal/body selectors and malformed input before accessing storage", async () => {
	const f = fixture();
	for (const body of [
		null,
		[],
		{
			expectedRevision: 0,
			postId: f.postId,
			principal: { kind: "agent", agentId: "lina" },
		},
		{ expectedRevision: 0, postId: f.postId, recipientId: "friends" },
		{ expectedRevision: 0.5, postId: f.postId },
		{ expectedRevision: 0, postId: "a".repeat(129) },
	])
		expect((await f.api("/feed/cursor", "PUT", body)).status).toBe(400);
	expect(
		(
			await fetch(f.url("/feed/cursor"), {
				method: "PUT",
				headers: {
					authorization: f.bearer,
					"content-type": "application/json",
				},
				body: "{",
			})
		).status,
	).toBe(400);
	expect(f.services.store).not.toHaveBeenCalled();
});

test("errors contain generic messages and security headers, never underlying model/SQL/private content", async () => {
	const f = fixture();
	f.services.store.mockImplementation(() => {
		throw Error("SQL SELECT private_body nativeReference token sentinel");
	});
	const response = await f.api("/publication/settings");
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({
		error: "Invalid publication request",
	});
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	f.services.store.mockImplementation(() => {
		throw Error("Installation ownership changed: private sentinel");
	});
	expect((await f.api("/publication/settings")).status).toBe(403);
});

test("manual run preserves core zero revision inputs for not-configured admission", async () => {
	const f = fixture();
	const body = {
		requestKey: "unconfigured",
		expectedConfigRevision: 0,
		expectedSettingsRevision: 0,
	};
	expect((await f.api("/publication/run", "POST", body)).status).toBe(200);
	expect(f.services.run.mock.calls[0]?.[1]).toEqual({
		...body,
		mode: "manual",
	});
	expect(f.services.store).not.toHaveBeenCalled();
});

test("every read rechecks the resolved grant and recipient removal blocks later reads", async () => {
	for (const suffix of ["/feed", "/feed/cursor", "/feed/posts/missing"]) {
		const f = fixture();
		const authenticate = f.store.authenticatePublicationViewer.bind(f.store);
		f.store.authenticatePublicationViewer = (worldId, token) => {
			const grant = authenticate(worldId, token);
			f.store.revokePublicationViewer(worldId, f.grant.id, {
				requestKey: "after-resolution",
				expectedRevision: 1,
			});
			return grant;
		};
		expect((await f.api(suffix)).status).toBe(403);
	}
	const f = fixture();
	const {
		worldId: _world,
		revision,
		...config
	} = f.store.lifeConfig("test-world");
	f.store.setLifeConfig("test-world", revision, {
		...config,
		publication: { mode: "manual", recipientIds: [] },
	});
	const before = f.digest();
	expect((await f.api("/feed")).status).toBe(403);
	expect(f.digest()).toBe(before);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("all recognized routes enforce their fixed methods before storage", async () => {
	const f = fixture();
	for (const [suffix, allowed] of [
		["/publication/settings", "GET, PUT"],
		["/publication/viewers", "POST"],
		["/publication/viewers/grant/revoke", "POST"],
		["/publication/run", "POST"],
		["/publication/jobs/job", "GET"],
		["/publication/jobs/job/retry", "POST"],
		["/publication/posts/post/withdraw", "POST"],
		["/feed", "GET"],
		["/feed/posts/post", "GET"],
		["/feed/cursor", "GET, PUT"],
		["/feed/posts/post/replies", "POST"],
		["/feed/posts/post/reactions", "PUT"],
		["/feed/posts/post/reshares", "POST"],
	] as const) {
		const response = await f.api(suffix, "DELETE");
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe(allowed);
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP pagination passes bounded cursors to core without exposing cursor or grant errors", async () => {
	const f = fixture();
	const before = f.digest();
	for (const [after, status] of [
		["invalid-cursor", 400],
		[
			Buffer.from(
				JSON.stringify({ version: 1, scope: "0".repeat(64), postId: f.postId }),
			).toString("base64url"),
			403,
		],
	] as const) {
		const response = await f.api(`/feed?after=${after}&limit=100`);
		expect(response.status).toBe(status);
		const message = await response.text();
		expect(message.includes(after)).toBe(false);
		expect(message.includes(f.grant.id)).toBe(false);
	}
	expect(f.digest()).toBe(before);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("raw TCP normalized world and feed routes require the effective world's bearer", async () => {
	const f = fixture();
	f.store.create(worldDefinition("other-world"));
	const before = f.digest();
	const host = new URL(f.url("")).host;
	for (const path of [`${base}\\feed`, `${base}/publication/../feed`]) {
		expect(
			await rawGet(f.url(""), path, { Host: host, Authorization: f.bearer }),
		).toBe(200);
		expect(f.observedPaths.at(-1)).toBe(`${base}/feed`);
		expect(await rawGet(f.url(""), path, { Host: host })).toBe(403);
	}
	for (const path of [
		`${base}/../other-world/feed`,
		`${base}\\..\\other-world\\feed`,
	]) {
		expect(
			await rawGet(f.url(""), path, { Host: host, Authorization: f.bearer }),
		).toBe(403);
		expect(f.observedPaths.at(-1)).toBe("/api/life/worlds/other-world/feed");
	}
	expect(f.digest()).toBe(before);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("raw TCP normalized feed routes reject malformed Host before storage access", async () => {
	const f = fixture();
	for (const path of [`${base}\\feed`, `${base}/publication/../feed`]) {
		expect(
			await rawGet(f.url(""), path, {
				Host: "127.0.0.1:invalid",
				Authorization: f.bearer,
			}),
		).toBe(403);
		expect(f.observedPaths.at(-1)).toBeNull();
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

test("raw TCP feed-to-management normalization still rejects every present Origin", async () => {
	const f = fixture();
	const host = new URL(f.url("")).host;
	for (const path of [
		`${base}/feed/../publication/settings`,
		`${base}\\feed\\..\\publication\\settings`,
	]) {
		for (const origin of ["http://foreign.example", `http://${host}`, "null"]) {
			expect(
				await rawGet(f.url(""), path, {
					Host: host,
					Origin: origin,
					Authorization: f.bearer,
				}),
			).toBe(403);
			expect(f.observedPaths.at(-1)).toBe(`${base}/publication/settings`);
		}
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

function feedbackFixture() {
	const f = fixture();
	const current = f.store.publicationSettings("test-world");
	if (!current) throw Error("Missing publication settings fixture");
	const { worldId, revision, ...settings } = current;
	f.store.setPublicationSettings(worldId, revision, {
		...settings,
		reactionIds: ["support"],
	});
	return f;
}

async function publicMutation(response: Response) {
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	const value = await jsonObject(response);
	expect(Object.keys(value).sort()).toEqual(["effective", "post", "replayed"]);
	const wire = JSON.stringify(value);
	for (const hidden of [
		"observationIds",
		"interactionId",
		"grantId",
		"roots",
		"audience",
		"requestKey",
		"nativeReference",
		"material",
	])
		expect(wire.includes(hidden)).toBe(false);
	return value;
}

function returnedPostId(value: Record<string, unknown>): string {
	const post = value["post"];
	if (
		!post ||
		typeof post !== "object" ||
		!("id" in post) ||
		typeof post.id !== "string"
	)
		throw Error("Missing public post fixture");
	return post.id;
}

test("HTTP replies create public posts and once-only observations; duplicates and feed reads do not signal", async () => {
	const f = feedbackFixture();
	const before = f.store.lifeSnapshot("test-world");
	const body = {
		requestKey: "http-reply",
		expectedPostRevision: 1,
		text: "Thanks for sharing.",
	};
	const suffix = `/feed/posts/${f.postId}/replies`;
	const value = await publicMutation(await f.api(suffix, "POST", body));
	const postId = returnedPostId(value);
	expect(value).toEqual({
		post: {
			id: postId,
			revision: 1,
			kind: "reply",
			author: { kind: "viewer" },
			parentPostId: f.postId,
			segments: [{ kind: "user_authored", text: body.text }],
			reactions: [{ reactionId: "support", active: false }],
			createdAt: 1000,
		},
		effective: true,
		replayed: false,
	});
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	expect(f.services.changed).toHaveBeenCalledWith("test-world");
	const settled = f.digest();
	for (let index = 0; index < 2; index++) {
		expect(await publicMutation(await f.api(suffix, "POST", body))).toEqual({
			...value,
			replayed: true,
		});
		expect((await f.api(`/feed/posts/${postId}`)).status).toBe(200);
		expect((await f.api("/feed")).status).toBe(200);
		expect(f.digest()).toBe(settled);
		f.reopen();
	}
	expect(f.store.lifeInputs("test-world")).toHaveLength(1);
	expect(f.store.lifeInputs("test-world")[0]?.source).toMatchObject({
		kind: "publication_interaction",
		principal: { kind: "viewer", grantId: f.grant.id },
		recipientAgentId: "lina",
	});
	expect(f.store.lifeSnapshot("test-world")).toEqual(before);
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP reaction add/remove is explicit; replaying an old add never reverses removal or signals", async () => {
	const f = feedbackFixture();
	const suffix = `/feed/posts/${f.postId}/reactions`;
	const add = {
		requestKey: "reaction-add",
		expectedPostRevision: 1,
		reactionId: "support",
		active: true,
	};
	const result = (effective: boolean, replayed = false) => ({
		post: null,
		effective,
		replayed,
	});
	expect(
		await publicMutation(
			await f.api(suffix, "PUT", {
				...add,
				requestKey: "initial-remove",
				active: false,
			}),
		),
	).toEqual(result(false));
	expect(f.services.changed).not.toHaveBeenCalled();
	expect(await publicMutation(await f.api(suffix, "PUT", add))).toEqual(
		result(true),
	);
	expect(await publicMutation(await f.api(suffix, "PUT", add))).toEqual(
		result(true, true),
	);
	expect(
		await publicMutation(
			await f.api(suffix, "PUT", { ...add, requestKey: "already-added" }),
		),
	).toEqual(result(false));
	const remove = { ...add, requestKey: "reaction-remove", active: false };
	expect(await publicMutation(await f.api(suffix, "PUT", remove))).toEqual(
		result(true),
	);
	f.reopen();
	expect(await publicMutation(await f.api(suffix, "PUT", add))).toEqual(
		result(true, true),
	);
	expect(
		await publicMutation(
			await f.api(suffix, "PUT", { ...remove, requestKey: "still-removed" }),
		),
	).toEqual(result(false));
	expect(f.store.lifeInputs("test-world")).toHaveLength(2);
	expect(f.services.changed).toHaveBeenCalledTimes(2);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP reshares return scoped public posts and duplicate keys/new-key noops do not notify", async () => {
	const f = feedbackFixture();
	const suffix = `/feed/posts/${f.postId}/reshares`;
	const body = { requestKey: "reshare", expectedPostRevision: 1 };
	const value = await publicMutation(await f.api(suffix, "POST", body));
	expect(value).toMatchObject({
		post: {
			kind: "reshare",
			parentPostId: f.postId,
			author: { kind: "viewer" },
			segments: [
				{
					kind: "claim",
					claimKind: "world_event",
					text: "A bell rang during the meeting",
				},
			],
		},
		effective: true,
		replayed: false,
	});
	f.reopen();
	expect(await publicMutation(await f.api(suffix, "POST", body))).toEqual({
		...value,
		replayed: true,
	});
	expect(
		await publicMutation(
			await f.api(suffix, "POST", { ...body, requestKey: "already-shared" }),
		),
	).toEqual({ ...value, effective: false });
	expect(f.store.lifeInputs("test-world")).toHaveLength(1);
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	const before = f.digest();
	expect(
		(await f.api(suffix, "POST", { ...body, audience: ["everyone"] })).status,
	).toBe(400);
	expect(f.digest()).toBe(before);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("HTTP interactions reject actor spoofing, invalid fields/limits, stale revisions and changed duplicate payloads", async () => {
	const f = feedbackFixture();
	const suffix = `/feed/posts/${f.postId}/replies`;
	const body = {
		requestKey: "reply-cas",
		expectedPostRevision: 1,
		text: "Visible reply",
	};
	for (const extra of [
		{ principal: { kind: "agent", agentId: "lina" } },
		{ grantId: f.grant.id },
		{ recipientId: "friends" },
		{ audience: ["friends"] },
		{ model: "injected" },
	])
		expect((await f.api(suffix, "POST", { ...body, ...extra })).status).toBe(
			400,
		);
	for (const patch of [
		{ text: " " },
		{ text: "x".repeat(32769) },
		{ expectedPostRevision: 0 },
		{ expectedPostRevision: 1.5 },
		{ requestKey: "x".repeat(129) },
	])
		expect((await f.api(suffix, "POST", { ...body, ...patch })).status).toBe(
			400,
		);
	expect(
		(
			await f.api(`/feed/posts/${f.postId}/reactions`, "PUT", {
				requestKey: "bad-active",
				expectedPostRevision: 1,
				reactionId: "support",
				active: "true",
			})
		).status,
	).toBe(400);
	expect(f.services.store).not.toHaveBeenCalled();
	expect(
		(await f.api(suffix, "POST", { ...body, expectedPostRevision: 2 })).status,
	).toBe(409);
	await publicMutation(await f.api(suffix, "POST", body));
	expect(
		(await f.api(suffix, "POST", { ...body, text: "Changed duplicate" }))
			.status,
	).toBe(409);
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	expect(f.store.lifeInputs("test-world")).toHaveLength(1);
});

test("HTTP interactions reject withdrawn/missing parents and forged, foreign-world or revoked bearers without new effects", async () => {
	const f = feedbackFixture();
	f.store.create(worldDefinition("other-world"));
	for (const [action, method, extra] of [
		["replies", "POST", { text: "No disclosure" }],
		["reactions", "PUT", { reactionId: "support", active: true }],
		["reshares", "POST", {}],
	] as const) {
		const body = { requestKey: action, expectedPostRevision: 1, ...extra };
		expect(
			(await f.api(`/feed/posts/missing/${action}`, method, body)).status,
		).toBe(404);
		expect(
			(
				await f.api(`/feed/posts/${f.postId}/${action}`, method, body, {
					authorization: `Bearer llv1_${"A".repeat(43)}`,
				})
			).status,
		).toBe(403);
		expect(
			(
				await fetch(
					f
						.url(`/feed/posts/${f.postId}/${action}`)
						.replace("test-world", "other-world"),
					{
						method,
						headers: {
							authorization: f.bearer,
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					},
				)
			).status,
		).toBe(403);
	}
	f.store.withdrawPublicationPost("test-world", f.postId, {
		requestKey: "parent-withdraw",
		expectedRevision: 1,
	});
	const before = f.digest();
	for (const [action, method, extra] of [
		["replies", "POST", { text: "No disclosure" }],
		["reactions", "PUT", { reactionId: "support", active: true }],
		["reshares", "POST", {}],
	] as const)
		expect(
			(
				await f.api(`/feed/posts/${f.postId}/${action}`, method, {
					requestKey: action,
					expectedPostRevision: 1,
					...extra,
				})
			).status,
		).toBe(404);
	expect(f.digest()).toBe(before);
	f.store.revokePublicationViewer("test-world", f.grant.id, {
		requestKey: "revoke-interaction",
		expectedRevision: 1,
	});
	expect(
		(
			await f.api(`/feed/posts/${f.postId}/replies`, "POST", {
				requestKey: "revoked",
				expectedPostRevision: 1,
				text: "No",
			})
		).status,
	).toBe(403);
	expect(f.store.lifeInputs("test-world")).toHaveLength(0);
	expect(f.services.changed).not.toHaveBeenCalled();
});

test("HTTP interactions reauthenticate after awaiting the body and recheck parent visibility", async () => {
	for (const change of ["revoke", "withdraw"] as const) {
		const f = feedbackFixture();
		const entered = Promise.withResolvers<void>(),
			parsed = Promise.withResolvers<Record<string, unknown>>();
		const request = new Request(f.url(`/feed/posts/${f.postId}/replies`), {
			method: "POST",
			headers: {
				host: new URL(f.url("")).host,
				authorization: f.bearer,
				"content-type": "application/json",
			},
		});
		const pending = lifePublicationRoutes(request, f.services, () => {
			entered.resolve();
			return parsed.promise;
		});
		await Promise.race([
			entered.promise,
			pending.then(() => {
				throw Error("Interaction route did not await JSON");
			}),
		]);
		expect(f.services.store).not.toHaveBeenCalled();
		if (change === "revoke")
			f.store.revokePublicationViewer("test-world", f.grant.id, {
				requestKey: "during-body",
				expectedRevision: 1,
			});
		else
			f.store.withdrawPublicationPost("test-world", f.postId, {
				requestKey: "during-body",
				expectedRevision: 1,
			});
		parsed.resolve({
			requestKey: "racing-reply",
			expectedPostRevision: 1,
			text: "Hidden reply",
		});
		expect((await pending)?.status).toBe(change === "revoke" ? 403 : 404);
		expect(f.store.lifeInputs("test-world")).toHaveLength(0);
		expect(f.services.changed).not.toHaveBeenCalled();
	}
});

test("HTTP interaction response rechecks viewer and parent after committed mutation notification", async () => {
	for (const change of ["revoke", "withdraw"] as const) {
		const f = feedbackFixture();
		f.services.changed.mockImplementation(() => {
			if (change === "revoke")
				f.store.revokePublicationViewer("test-world", f.grant.id, {
					requestKey: "before-response",
					expectedRevision: 1,
				});
			else
				f.store.withdrawPublicationPost("test-world", f.postId, {
					requestKey: "before-response",
					expectedRevision: 1,
				});
		});
		const response = await f.api(`/feed/posts/${f.postId}/replies`, "POST", {
			requestKey: "accepted-before-revocation",
			expectedPostRevision: 1,
			text: "Do not send this text",
		});
		expect(response.status).toBe(change === "revoke" ? 403 : 404);
		expect(await response.json()).toEqual({
			error: change === "revoke" ? "Forbidden" : "Not found",
		});
		expect(f.store.lifeInputs("test-world")).toHaveLength(1);
		expect(f.services.changed).toHaveBeenCalledTimes(1);
		expect(f.services.run).not.toHaveBeenCalled();
	}
});

test("management changed signal fires only for effective settings/revoke and stays silent on replay/noop/read", async () => {
	const f = fixture();
	const current = f.store.publicationSettings("test-world");
	if (!current) throw Error("Missing settings fixture");
	const { worldId: _world, revision, ...settings } = current;
	expect(
		(
			await f.api("/publication/settings", "PUT", {
				expectedRevision: revision,
				settings,
			})
		).status,
	).toBe(200);
	expect(f.services.changed).not.toHaveBeenCalled();
	const updated = { ...settings, maxJobsPerRun: 2 };
	expect(
		(
			await f.api("/publication/settings", "PUT", {
				expectedRevision: 1,
				settings: updated,
			})
		).status,
	).toBe(200);
	expect(
		(
			await f.api("/publication/settings", "PUT", {
				expectedRevision: 2,
				settings: updated,
			})
		).status,
	).toBe(200);
	expect((await f.api("/publication/settings")).status).toBe(200);
	expect(f.services.changed).toHaveBeenCalledTimes(1);
	const suffix = `/publication/viewers/${f.grant.id}/revoke`,
		body = { requestKey: "signal-revoke", expectedRevision: 1 };
	expect((await f.api(suffix, "POST", body)).status).toBe(200);
	expect((await f.api(suffix, "POST", body)).status).toBe(200);
	expect(
		(
			await f.api(suffix, "POST", {
				requestKey: "already-revoked",
				expectedRevision: 2,
			})
		).status,
	).toBe(200);
	expect(f.services.changed).toHaveBeenCalledTimes(2);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("each interaction route applies ingress and query guards before opening storage", async () => {
	const f = feedbackFixture();
	for (const [action, method, extra] of [
		["replies", "POST", { text: "Valid text" }],
		["reactions", "PUT", { reactionId: "support", active: true }],
		["reshares", "POST", {}],
	] as const) {
		const body = { requestKey: action, expectedPostRevision: 1, ...extra };
		const suffix = `/feed/posts/${f.postId}/${action}`;
		for (const headers of [
			{ origin: "http://foreign.example" },
			{ host: "foreign.example" },
			{ authorization: "" },
		])
			expect((await f.api(suffix, method, body, headers)).status).toBe(403);
		for (const headers of [
			{ "content-type": "text/plain" },
			{ "content-encoding": "gzip" },
		])
			expect((await f.api(suffix, method, body, headers)).status).toBe(400);
		for (const query of [
			"?principal=agent",
			"?recipientId=friends",
			"?limit=1",
		])
			expect((await f.api(`${suffix}${query}`, method, body)).status).toBe(400);
		for (const malformed of [
			`${suffix}/`,
			`${suffix}/extra`,
			`/feed/posts/a%2Fb/${action}`,
			`/feed/posts/a%5Cb/${action}`,
		])
			expect((await f.api(malformed, method, body)).status).toBe(404);
	}
	expect(f.services.store).not.toHaveBeenCalled();
	expect(f.services.changed).not.toHaveBeenCalled();
	expect(f.services.run).not.toHaveBeenCalled();
});

test("interaction callback is optional and installation ownership is checked again before output", async () => {
	const f = feedbackFixture();
	const input = {
		requestKey: "without-callback",
		expectedPostRevision: 1,
		text: "Optional wake",
	};
	const request = new Request(f.url(`/feed/posts/${f.postId}/replies`), {
		method: "POST",
		headers: {
			host: new URL(f.url("")).host,
			authorization: f.bearer,
			"content-type": "application/json",
		},
	});
	const response = await lifePublicationRoutes(
		request,
		{ store: f.services.store, run: f.services.run },
		async () => input,
	);
	if (!response) throw Error("Missing interaction response");
	await publicMutation(response);
	expect(f.services.changed).not.toHaveBeenCalled();
	f.services.changed.mockImplementation(() => {
		f.services.store.mockImplementation(() => {
			throw Error("Installation ownership revoked");
		});
	});
	const denied = await f.api(`/feed/posts/${f.postId}/replies`, "POST", {
		...input,
		requestKey: "owner-lost-after-commit",
	});
	expect(denied.status).toBe(403);
	expect(await denied.json()).toEqual({ error: "Forbidden" });
	expect(f.store.lifeInputs("test-world")).toHaveLength(2);
	expect(f.services.run).not.toHaveBeenCalled();
});

test("image projection receives only requested visible post IDs", async () => {
	const f = fixture();
	const seen: unknown[] = [];
	const services = {
		...f.services,
		images: (...args: unknown[]) => {
			seen.push(args[2]);
			return new Map();
		},
	};
	for (const suffix of [
		"/feed?limit=1",
		"/feed/posts/" + f.postId,
		"/feed/posts/absent",
	]) {
		await lifePublicationRoutes(
			new Request(f.url(suffix), {
				headers: { authorization: f.bearer, host: new URL(f.url(suffix)).host },
			}),
			services,
			async () => ({}),
		);
	}
	expect(seen).toEqual([[f.postId], [f.postId], []]);
});
