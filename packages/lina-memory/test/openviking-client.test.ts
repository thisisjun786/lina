import { describe, expect, it } from "bun:test";
import {
	OpenVikingClient,
	OpenVikingRequestError,
	type OpenVikingWriteMode,
} from "../src/openviking/index.ts";

const config = {
	baseUrl: "http://127.0.0.1:1933",
	apiKey: "test-key",
	rootUri: "viking://resources/lina",
};

type Seen = {
	method: string;
	url: string;
	body: unknown;
	headers: Record<string, string>;
	redirect?: RequestInit["redirect"];
};

class FakeOpenViking {
	readonly seen: Seen[] = [];
	behavior:
		| ((seen: Seen) => Response | Promise<Response> | undefined)
		| undefined;
	store = new Map<string, string>([
		["viking://resources/lina/notes.md", "hello from source e1 task t1"],
	]);

	get fetch() {
		return async (url: string, init: RequestInit): Promise<Response> => {
			const headers = Object.fromEntries(
				Object.entries((init.headers ?? {}) as Record<string, string>),
			);
			const seen: Seen = {
				method: init.method ?? "GET",
				url,
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
				headers,
				redirect: init.redirect,
			};
			this.seen.push(seen);
			const signal = init.signal ?? null;
			const custom = await Promise.race([
				Promise.resolve(this.behavior?.(seen)),
				new Promise<never>((_, reject) => {
					if (!signal) return;
					const fail = () => reject(new Error("aborted"));
					if (signal.aborted) fail();
					else signal.addEventListener("abort", fail, { once: true });
				}),
			]);
			if (custom) return custom;
			return this.route(seen);
		};
	}

	private json(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	private route(seen: Seen): Response {
		const parsed = new URL(seen.url);
		if (parsed.pathname === "/api/v1/fs/ls" && seen.method === "GET") {
			const uri = parsed.searchParams.get("uri") ?? "";
			return this.json(200, {
				status: "ok",
				result: [
					{
						uri: `${uri.replace(/\/$/, "")}/notes.md`,
						name: "notes.md",
						isDir: false,
						rel_path: "notes.md",
					},
				],
			});
		}
		if (parsed.pathname === "/api/v1/content/read" && seen.method === "GET") {
			const uri = parsed.searchParams.get("uri") ?? "";
			const content = this.store.get(uri);
			if (content === undefined)
				return this.json(404, {
					status: "error",
					error: { code: "NOT_FOUND", message: uri },
				});
			return this.json(200, { status: "ok", result: content });
		}
		if (parsed.pathname === "/api/v1/search/find" && seen.method === "POST") {
			const body = (seen.body ?? {}) as Record<string, unknown>;
			return this.json(200, {
				status: "ok",
				result: {
					memories: [],
					skills: [],
					resources: [
						{
							uri: "viking://resources/lina/notes.md",
							score: 0.91,
							abstract: "hello from source e1 task t1",
							level: 2,
							context_type: "resource",
							sourceId: "e1",
							taskId: "t1",
							query: body["query"],
							target_uri: body["target_uri"],
						},
					],
				},
			});
		}
		if (parsed.pathname === "/api/v1/content/write" && seen.method === "POST") {
			const body = (seen.body ?? {}) as Record<string, unknown>;
			const uri = String(body["uri"]);
			this.store.set(uri, String(body["content"]));
			return this.json(200, {
				status: "ok",
				result: {
					uri,
					root_uri: config.rootUri,
					context_type: "resource",
					mode: body["mode"],
					written_bytes: String(body["content"]).length,
					content_updated: true,
					semantic_status: "queued",
					vector_status: "queued",
					queue_status: { state: "queued" },
				},
			});
		}
		return this.json(404, { status: "error", error: { code: "NOT_FOUND" } });
	}
}

describe("OpenVikingClient", () => {
	it("lists, reads, finds and writes through the pinned HTTP contracts with X-API-Key only", async () => {
		const fake = new FakeOpenViking();
		const client = new OpenVikingClient(config, { fetch: fake.fetch });
		expect(client.status).toEqual({
			service: "configured",
			baseUrl: config.baseUrl,
			rootUri: config.rootUri,
		});

		const listed = await client.list();
		expect(listed.uri).toBe("viking://resources/lina");
		expect(listed.entries).toEqual([
			{
				uri: "viking://resources/lina/notes.md",
				name: "notes.md",
				isDir: false,
				relPath: "notes.md",
			},
		]);
		expect(fake.seen[0]?.method).toBe("GET");
		expect(fake.seen[0]?.url).toBe(
			"http://127.0.0.1:1933/api/v1/fs/ls?uri=viking%3A%2F%2Fresources%2Flina&output=original",
		);
		expect(fake.seen[0]?.redirect).toBe("manual");
		expect(fake.seen[0]?.headers["X-API-Key"]).toBe("test-key");
		expect(fake.seen[0]?.headers["authorization"]).toBeUndefined();
		expect(fake.seen[0]?.headers["Authorization"]).toBeUndefined();

		const read = await client.read("notes.md", 0, 20);
		expect(read).toEqual({
			uri: "viking://resources/lina/notes.md",
			content: "hello from source e1 task t1",
			offset: 0,
			limit: 20,
		});
		expect(fake.seen[1]?.url).toContain("/api/v1/content/read?");
		expect(fake.seen[1]?.url).toContain("offset=0");
		expect(fake.seen[1]?.url).toContain("limit=20");

		const found = await client.find("task t1");
		expect(found.query).toBe("task t1");
		expect(found.uri).toBe("viking://resources/lina");
		expect(found.hits).toEqual([
			{
				uri: "viking://resources/lina/notes.md",
				kind: "resource",
				score: 0.91,
				abstract: "hello from source e1 task t1",
				sourceId: "e1",
				taskId: "t1",
			},
		]);
		expect(fake.seen[2]?.method).toBe("POST");
		expect(fake.seen[2]?.url).toBe("http://127.0.0.1:1933/api/v1/search/find");
		expect(fake.seen[2]?.body).toEqual({
			query: "task t1",
			target_uri: "viking://resources/lina",
		});

		const written = await client.write(
			"decisions.md",
			"source e2 task t2: keep indexing async",
			"create",
		);
		expect(written.uri).toBe("viking://resources/lina/decisions.md");
		expect(written.mode).toBe("create");
		expect(written.retrievalReady).toBe(false);
		expect(written.semanticStatus).toBe("queued");
		expect(written.vectorStatus).toBe("queued");
		expect(fake.seen[3]?.body).toEqual({
			uri: "viking://resources/lina/decisions.md",
			content: "source e2 task t2: keep indexing async",
			mode: "create",
			wait: false,
		});
		expect(
			fake.seen.every((seen) => seen.headers["X-API-Key"] === "test-key"),
		).toBe(true);
		expect(
			fake.seen.every(
				(seen) =>
					seen.headers["authorization"] === undefined &&
					seen.headers["Authorization"] === undefined,
			),
		).toBe(true);
		expect(
			fake.seen.every((seen) => !seen.url.includes("/api/v1/resources")),
		).toBe(true);
	});

	it("surfaces HTTP status, redirect, timeout, oversized and malformed bodies without retrying or empty results", async () => {
		const fake = new FakeOpenViking();
		const client = new OpenVikingClient(config, {
			fetch: fake.fetch,
			timeoutMs: 50,
			bodyCapBytes: 64,
		});
		const kinds: string[] = [];
		const attempt = async (behavior: FakeOpenViking["behavior"]) => {
			fake.behavior = behavior;
			try {
				await client.list();
				kinds.push("empty-success");
			} catch (error) {
				if (!(error instanceof OpenVikingRequestError)) throw error;
				kinds.push(error.kind);
			}
		};
		await attempt(
			() =>
				new Response(
					JSON.stringify({
						status: "error",
						error: { code: "UNAUTHENTICATED", message: "missing key" },
					}),
					{ status: 401 },
				),
		);
		await attempt(
			() =>
				new Response(null, {
					status: 307,
					headers: { location: "https://evil.example" },
				}),
		);
		await attempt(() => new Promise<Response>(() => undefined));
		await attempt(
			() =>
				new Response(`{"status":"ok","result":"${"x".repeat(200)}"}`, {
					status: 200,
				}),
		);
		await attempt(() => new Response("<html>", { status: 200 }));
		await attempt(() => {
			throw new TypeError("fetch failed");
		});
		await attempt(
			() => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
		);
		expect(kinds).toEqual([
			"status",
			"redirect",
			"timeout",
			"body",
			"body",
			"network",
			"body",
		]);
		expect(fake.seen.length).toBe(7);
	});

	it("does not pretend a disabled client is successful empty memory", async () => {
		const client = new OpenVikingClient(undefined);
		expect(client.status.service).toBe("disabled");
		await expect(client.list()).rejects.toThrow(/disabled/);
		await expect(client.find("anything")).rejects.toThrow(/disabled/);
		try {
			await client.read("notes.md");
		} catch (error) {
			expect(error).toBeInstanceOf(OpenVikingRequestError);
			expect((error as OpenVikingRequestError).kind).toBe("disabled");
		}
	});

	it("rejects write modes outside create/append/replace", async () => {
		const fake = new FakeOpenViking();
		const client = new OpenVikingClient(config, { fetch: fake.fetch });
		await expect(
			client.write("x.md", "n", "upsert" as OpenVikingWriteMode),
		).rejects.toThrow(/mode/);
		expect(fake.seen.length).toBe(0);
	});
});
