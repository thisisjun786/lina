import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { resourceRoutes } from "../src/fleet/resource-routes.ts";

const scope = {
	principalId: "installation:test",
	agentId: "installation:test",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};
const request = (path: string, method = "GET", body?: unknown) =>
	new Request(`http://127.0.0.1:19999${path}`, {
		method,
		headers: {
			host: "127.0.0.1:19999",
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});

test("resource API uses host scope for creation reading and binary upload", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-api-")),
		store = new ResourceStore(root, limits),
		options = { store, scope: () => scope };
	try {
		const response = await resourceRoutes(
			request("/api/resources", "POST", {
				operationId: "doc",
				kind: "document",
				title: "자료",
				visibility: "private",
				mediaType: "text/plain",
				text: "원문",
			}),
			options,
		);
		expect(response?.status).toBe(201);
		const doc = z.object({ id: z.uuid() }).parse(await response?.json());
		const read = await resourceRoutes(
			request(`/api/resources/${doc.id}/content`),
			options,
		);
		expect(z.object({ text: z.string() }).parse(await read?.json()).text).toBe(
			"원문",
		);
		const forbidden = await resourceRoutes(
			request("/api/resources", "POST", {
				operationId: "bad",
				kind: "collection",
				title: "침입",
				visibility: "shared",
				principalId: "agent:other",
			}),
			options,
		);
		expect(forbidden?.status).toBe(400);
		const binary = await resourceRoutes(
			request("/api/resources", "POST", {
				operationId: "binary",
				kind: "document",
				title: "이미지",
				visibility: "private",
				mediaType: "image/png",
				base64: "AQID",
			}),
			options,
		);
		const image = z.object({ id: z.uuid() }).parse(await binary?.json());
		const descriptor = await resourceRoutes(
			request(`/api/resources/${image.id}/content`),
			options,
		);
		expect(
			z
				.object({ original: z.object({ byteLength: z.number() }) })
				.parse(await descriptor?.json()).original.byteLength,
		).toBe(3);
		const forged = new Request("http://127.0.0.1:19999/api/resources", {
			headers: { host: "127.0.0.1:19999", origin: "https://evil.invalid" },
		});
		expect((await resourceRoutes(forged, options))?.status).toBe(403);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("API rejects invalid binary and oversized bodies before catalog mutation", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-api-invalid-")),
		store = new ResourceStore(root, limits),
		options = { store, scope: () => scope };
	try {
		for (const content of [
			{ base64: "!notbase64" },
			{ base64: "AQID", text: "both" },
			{ text: "x".repeat(40000) },
		]) {
			const response = await resourceRoutes(
				request("/api/resources", "POST", {
					operationId: "bad",
					kind: "document",
					title: "Bad",
					visibility: "private",
					mediaType: "text/plain",
					...content,
				}),
				options,
			);
			expect(response?.status).toBe(400);
			expect(store.list(scope).items).toHaveLength(0);
		}
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("API scope is rechecked after the streamed body is read", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-api-scope-")),
		store = new ResourceStore(root, limits);
	let current = scope;
	try {
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				current = { ...scope, principalId: "agent:b", agentId: "b" };
				controller.enqueue(
					new TextEncoder().encode(
						JSON.stringify({
							operationId: "bad",
							kind: "collection",
							title: "Bad",
							visibility: "shared",
						}),
					),
				);
				controller.close();
			},
		});
		const streamed = new Request("http://127.0.0.1:19999/api/resources", {
			method: "POST",
			headers: { host: "127.0.0.1:19999", "content-type": "application/json" },
			body,
		});
		const response = await resourceRoutes(streamed, {
			store,
			scope: () => current,
		});
		expect(response?.status).toBe(409);
		expect(store.list(scope).items).toHaveLength(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("host can download original bytes and delete with an operation receipt", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-api-original-")),
		store = new ResourceStore(root, limits),
		options = { store, scope: () => scope };
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "이미지",
			visibility: "private",
			mediaType: "image/png",
			bytes: new Uint8Array([1, 2, 3]),
		});
		const downloaded = await resourceRoutes(
			request(`/api/resources/${doc.id}/content?format=original`),
			options,
		);
		expect(downloaded?.status).toBe(200);
		if (!downloaded) throw Error("missing response");
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		const deleted = await resourceRoutes(
			request(`/api/resources/${doc.id}`, "DELETE", {
				operationId: "delete",
				expectedRevision: 1,
			}),
			options,
		);
		expect(deleted?.status).toBe(200);
		expect(
			(
				await resourceRoutes(
					request(`/api/resources/${doc.id}/content?format=original`),
					options,
				)
			)?.status,
		).toBe(404);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
