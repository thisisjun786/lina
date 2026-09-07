import { describe, expect, it } from "bun:test";
import {
	createOpenVikingTools,
	OpenVikingClient,
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
};

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

describe("openviking tools", () => {
	it("returns lina_work_list/read/search/write with JSON Schema and signal-aware execute", async () => {
		const seen: Seen[] = [];
		const fetch = async (url: string, init: RequestInit) => {
			const headers = Object.fromEntries(
				Object.entries((init.headers ?? {}) as Record<string, string>),
			);
			const request: Seen = {
				method: init.method ?? "GET",
				url,
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
				headers,
			};
			seen.push(request);
			const parsed = new URL(url);
			if (parsed.pathname === "/api/v1/fs/ls")
				return json(200, { status: "ok", result: [] });
			if (parsed.pathname === "/api/v1/content/read")
				return json(200, {
					status: "ok",
					result: "source e9 task t9",
				});
			if (parsed.pathname === "/api/v1/search/find")
				return json(200, {
					status: "ok",
					result: {
						memories: [],
						skills: [],
						resources: [
							{
								uri: "viking://resources/lina/notes.md",
								score: 0.5,
								abstract: "source e9 task t9",
								sourceId: "e9",
								taskId: "t9",
							},
						],
					},
				});
			if (parsed.pathname === "/api/v1/content/write")
				return json(200, {
					status: "ok",
					result: {
						uri: "viking://resources/lina/notes.md",
						mode: "replace",
						written_bytes: 12,
						semantic_status: "queued",
						vector_status: "queued",
					},
				});
			return json(404, { status: "error" });
		};
		const tools = createOpenVikingTools(
			new OpenVikingClient(config, { fetch }),
		);
		expect(tools.map((tool) => tool.name)).toEqual([
			"lina_work_list",
			"lina_work_read",
			"lina_work_search",
			"lina_work_write",
		]);
		for (const tool of tools) {
			expect(tool.parameters).toMatchObject({
				type: "object",
				additionalProperties: false,
			});
		}

		const listed = await tools[0]?.execute(
			"call-list",
			{},
			AbortSignal.timeout(500),
		);
		expect(listed?.details).toMatchObject({
			service: "configured",
			uri: "viking://resources/lina",
			entries: [],
		});

		const read = await tools[1]?.execute(
			"call-read",
			{ uri: "notes.md" },
			AbortSignal.timeout(500),
		);
		expect(read?.content[0]?.text).toContain("source e9 task t9");
		expect(read?.details).toMatchObject({
			uri: "viking://resources/lina/notes.md",
			sourceIds: ["e9"],
			taskIds: ["t9"],
		});

		const searched = await tools[2]?.execute(
			"call-search",
			{ query: "task t9" },
			AbortSignal.timeout(500),
		);
		expect(searched?.details).toMatchObject({
			query: "task t9",
			hits: [
				{
					uri: "viking://resources/lina/notes.md",
					kind: "resource",
					sourceId: "e9",
					taskId: "t9",
				},
			],
		});

		const written = await tools[3]?.execute(
			"call-write",
			{
				uri: "notes.md",
				content: "source e9 task t9 updated",
				mode: "replace",
			},
			AbortSignal.timeout(500),
		);
		expect(written?.content[0]?.text).toMatch(
			/index|queued|not retrieval-ready/i,
		);
		expect(written?.details).toMatchObject({
			uri: "viking://resources/lina/notes.md",
			retrievalReady: false,
			semanticStatus: "queued",
			vectorStatus: "queued",
		});
		expect(
			seen.some(
				(request) =>
					request.method === "POST" &&
					request.url.endsWith("/api/v1/content/write") &&
					(request.body as { wait: boolean }).wait === false,
			),
		).toBe(true);
	});

	it("makes disabled work memory visible instead of returning successful empty recall", async () => {
		const tools = createOpenVikingTools(new OpenVikingClient(undefined));
		const listed = await tools[0]?.execute("call-list", {});
		expect(listed?.content[0]?.text).toMatch(/disabled/i);
		expect(listed?.details).toMatchObject({ service: "disabled" });
		expect(listed?.details).not.toHaveProperty("entries");
		const searched = await tools[2]?.execute("call-search", {
			query: "anything",
		});
		expect(searched?.content[0]?.text).toMatch(/disabled/i);
		expect(searched?.details).not.toEqual({ hits: [] });
	});

	it("returns an error detail rather than an empty hit list when the server fails", async () => {
		const fetch = async () =>
			new Response(
				JSON.stringify({
					status: "error",
					error: { code: "UNAUTHENTICATED", message: "bad key" },
				}),
				{ status: 401 },
			);
		const tools = createOpenVikingTools(
			new OpenVikingClient(config, { fetch }),
		);
		const searched = await tools[2]?.execute("call-search", { query: "x" });
		expect(searched?.content[0]?.text).toMatch(/bad key|401|unauthenticated/i);
		expect(searched?.details).toMatchObject({ service: "unavailable" });
		expect(searched?.details).not.toHaveProperty("hits");
	});
});
