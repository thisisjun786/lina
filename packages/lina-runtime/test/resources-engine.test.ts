import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenCodexContextServices } from "../../lina-opencodex/src/services.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { ResourceEngine } from "../src/resources/services.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 8192,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 8192,
};

test("resource owner runs persisted extraction and actual adapter summary requests", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-owner-"));
	let requests = 0;
	const svc = createOpenCodexContextServices(
		{
			origin: () => "http://127.0.0.1:10100",
			token: () => null,
			models: () => [
				{
					provider: "opencodex",
					id: "test-model",
					name: "test",
					contextWindow: 32768,
					maxOutputTokens: 4096,
					reasoning: false,
					authenticated: true,
					endpoint: "responses",
					imageInput: false,
				},
			],
			fetchImpl: async (_url, init) => {
				requests++;
				const body = JSON.parse(String(init?.body));
				expect(body.max_output_tokens).toBe(128);
				expect(JSON.stringify(body)).toContain("근거 원문");
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "자료 요약" }] }], usage: { input_tokens: 8, output_tokens: 3 } } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
		() => ({
			revision: 0,
			profiles: [
				{
					id: "test",
					provider: "opencodex",
					model: "test-model",
					reasoning: "off",
					maxOutputTokens: 128,
				},
			],
			defaultProfileId: "test",
			roles: { summary: "test" },
			agentRoles: {},
		}),
	);
	const engine = new ResourceEngine({
		root,
		limits,
		scope: () => scope,
		services: () => svc,
		policy: defaultEnginePolicy,
	});
	try {
		const doc = engine.store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("근거 원문"),
		});
		const results = await engine.runPending(
			doc.id,
			new AbortController().signal,
		);
		expect(results.map((r) => r.state)).toEqual(["ready", "ready"]);
		expect(requests).toBe(1);
		expect(engine.store.indexing.read(scope, doc.id, "brief")?.text).toBe(
			"자료 요약",
		);
		expect(() => engine.recover()).toThrow(/ownership/);
	} finally {
		engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("orderly owner close drains the claimed job before closing its database", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-owner-close-"));
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const svc = createOpenCodexContextServices(
		{
			origin: () => "http://127.0.0.1:10100",
			token: () => null,
			models: () => [
				{
					provider: "opencodex",
					id: "test-model",
					name: "test",
					contextWindow: 32768,
					maxOutputTokens: 4096,
					reasoning: false,
					authenticated: true,
					endpoint: "responses",
					imageInput: false,
				},
			],
			fetchImpl: async () => {
				entered.resolve();
				await release.promise;
				throw Error("cancelled provider");
			},
		},
		() => ({
			revision: 0,
			profiles: [
				{
					id: "test",
					provider: "opencodex",
					model: "test-model",
					reasoning: "off",
				},
			],
			defaultProfileId: "test",
			roles: { summary: "test" },
			agentRoles: {},
		}),
	);
	const engine = new ResourceEngine({
		root,
		limits,
		scope: () => scope,
		services: () => svc,
		policy: defaultEnginePolicy,
	});
	try {
		const doc = engine.store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "資料",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const running = engine.runPending(doc.id, new AbortController().signal);
		await entered.promise;
		const closed = engine.close();
		release.resolve();
		await running;
		await closed;
		const reopened = new ResourceEngine({
			root,
			limits,
			scope: () => scope,
			services: () => svc,
			policy: defaultEnginePolicy,
		});
		try {
			expect(
				reopened.store.indexing
					.list(scope, doc.id)
					.find((j) => j.kind === "brief"),
			).toMatchObject({ state: "failed", error: "cancelled", attempt: 1 });
		} finally {
			await reopened.close();
		}
	} finally {
		release.resolve();
		await engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("pending batch reports a blocked private-version extraction instead of silently skipping it", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-owner-withheld-"));
	const svc = createOpenCodexContextServices(
		{
			origin: () => "http://127.0.0.1:10100",
			token: () => null,
			models: () => [],
			fetchImpl: async () => {
				throw Error("unexpected provider");
			},
		},
		() => ({
			revision: 0,
			profiles: [],
			defaultProfileId: null,
			roles: {},
			agentRoles: {},
		}),
	);
	const engine = new ResourceEngine({
		root,
		limits,
		scope: () => scope,
		services: () => svc,
		policy: defaultEnginePolicy,
	});
	try {
		const doc = engine.store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "private",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		engine.store.update(scope, {
			operationId: "share",
			id: doc.id,
			expectedRevision: 1,
			visibility: "shared",
		});
		const results = await engine.runPending(
			doc.id,
			new AbortController().signal,
		);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.state === "stale")).toBe(true);
	} finally {
		await engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});
