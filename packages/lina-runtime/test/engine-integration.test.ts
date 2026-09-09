import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import type { ContextServices } from "../src/context/port.ts";
import { ResourceEngine } from "../src/resources/services.ts";

const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
const scope = (id: string) => ({
	principalId: `agent:${id}`,
	agentId: id,
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
});
function services(): ContextServices {
	return {
		estimateText: conservativeEstimator.text,
		estimateMessages: conservativeEstimator.messages,
		estimator: conservativeEstimator,
		systemTokens: 0,
		contextWindow: 32000,
		reserveTokens: 1024,
		summarize: async () => "",
		prepare: () => {
			throw Error("unused");
		},
		resourceInputOverhead: () => 20,
	};
}
test("one resource owner isolates consumers and joins pending search before closing", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-owner-search-")),
		svc = services(),
		entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let finished = false;

	const engine = new ResourceEngine({
		root,
		limits,
		scope: () => scope("a"),
		services: () => svc,
		policy: defaultEnginePolicy,
	});
	try {
		const privateDoc = engine.store.create(scope("a"), {
			operationId: "private",
			kind: "document",
			title: "search private",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("secret"),
		});
		const b = engine.consumer(() => scope("b"));
		expect(
			(await b.search.search({ query: "search" }, new AbortController().signal))
				.items,
		).toEqual([]);
		svc.planResources = async () => '{"collectionIds":[],"terms":[]}';
		svc.rankResources = async (_text, _signal, before) => {
			before?.();
			entered.resolve();
			await release.promise;
			finished = true;
			return '{"ids":[]}';
		};
		const a = engine.consumer(() => scope("a"));
		const searching = a.search
			.search({ query: "search" }, new AbortController().signal)
			.catch(() => undefined);
		await entered.promise;
		let closed = false;
		const closing = engine.close().then(() => {
			closed = true;
		});
		expect(closed).toBe(false);
		expect(finished).toBe(false);
		release.resolve();
		await closing;
		await searching;
		expect(finished).toBe(true);
		expect(() => a.scope()).toThrow("closed");
		expect(() => engine.store.get(scope("a"), privateDoc.id)).toThrow();
	} finally {
		release.resolve();
		await engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("installation resource tools share one catalog without granting other agents private access", async () => {
	const { FleetResources } = await import("../src/fleet/resource-runtime.ts");
	const root = mkdtempSync(join(tmpdir(), "lina-fleet-resources-"));
	let owned = true;
	const owner = new FleetResources({
		root,
		limits,
		services,
		policy: defaultEnginePolicy,
		validAgent: (id) => ["a", "b"].includes(id),
		assertInstallation: () => {
			if (!owned) throw Error("lost owner");
		},
	});
	try {
		const result = await owner.executeTool(
			"lina_resource_put",
			"put",
			{
				operationId: "d",
				kind: "document",
				title: "Notes",
				visibility: "shared",
				text: "shared",
			},
			new AbortController().signal,
			{ taskId: "task", agentId: "a", revision: 1, assertCurrent: () => {} },
		);
		expect(result.success).toBe(true);
		await owner.drain();
		const r = owner.engine.store.list(scope("b")).items[0];
		if (!r) throw Error("missing sharedresource");
		expect(
			(
				await owner.executeTool(
					"lina_resource_read",
					"read",
					{ id: r.id },
					new AbortController().signal,
				)
			).success,
		).toBe(true);
		expect(
			owner.dynamicTools().some((t) => t.name === "lina_resource_memory_read"),
		).toBe(true);
		await owner.close();
		owned = false;
		expect(() => owner.consumer("a")).toThrow("closed");
	} finally {
		await owner.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("Fleet serves persistent engine policy and local shared resources with no external memory host", async () => {
	const { startCodexFleet } = await import("../src/fleet/codex-fleet.ts"),
		{ resolve } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "lina-integrated-fleet-")),
		opts = {
			workspace: resolve(import.meta.dir, "../../.."),
			stateRoot: root,
			port: 0,
			homeDir: root,
			env: {},
		};
	let app = await startCodexFleet(opts);
	try {
		let base = `http://127.0.0.1:${app.port}`;
		const policyResponse = await fetch(`${base}/api/engines/policy`);
		expect(policyResponse.status).toBe(200);
		const p = (await policyResponse.json()) as {
			revision: number;
			version: number;
		};
		const { revision, ...settings } = p;
		const patch = await fetch(`${base}/api/engines/policy`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: revision, settings }),
		});
		expect(patch.status).toBe(200);
		const conflict = await fetch(`${base}/api/engines/policy`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedRevision: revision, settings }),
		});
		expect(conflict.status).toBe(409);
		const privateResponse = await fetch(`${base}/api/agents/lina/resources`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "private",
				kind: "document",
				title: "Private",
				visibility: "private",
				text: "private data",
				mediaType: "text/plain",
			}),
		});
		expect(privateResponse.status).toBe(201);
		const privateResource = (await privateResponse.json()) as { id: string };
		expect(
			(await fetch(`${base}/api/resources/${privateResource.id}`)).status,
		).not.toBe(200);
		expect(
			(await fetch(`${base}/api/agents/lina/resources/${privateResource.id}`))
				.status,
		).toBe(200);
		const saved = await fetch(`${base}/api/resources`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "d",
				kind: "document",
				title: "Shared notes",
				visibility: "shared",
				text: "noncoding research",
				mediaType: "text/plain",
			}),
		});
		expect(saved.status).toBe(201);
		const r = (await saved.json()) as { id: string };
		await app.stop();
		app = await startCodexFleet(opts);
		base = `http://127.0.0.1:${app.port}`;
		expect((await fetch(`${base}/api/resources/${r.id}`)).status).toBe(200);
		expect(
			(
				(await (await fetch(`${base}/api/engines/policy`)).json()) as {
					revision: number;
				}
			).revision,
		).toBe(p.revision + 1);
	} finally {
		await app.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
