import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import { ResourceEngine } from "../src/resources/services.ts";

test("overview prepares extraction only inside its visit budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-overview-budget-"));
	const scope = {
		principalId: "agent:a",
		agentId: "a",
		allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
	};
	const base = defaultEnginePolicy();
	const policy = { ...base, resources: { ...base.resources, maxVisits: 2 } };
	let calls = 0;
	const engine = new ResourceEngine({
		root,
		limits: {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		},
		scope: () => scope,
		policy: () => policy,
		services: () => ({
			estimator: conservativeEstimator,
			estimateText: conservativeEstimator.text,
			estimateMessages: conservativeEstimator.messages,
			systemTokens: 0,
			contextWindow: 32000,
			reserveTokens: 1024,
			summarize: async () => "",
			prepare: () => {
				throw Error("unused");
			},
			resourceInputOverhead: () => 20,
			summarizeResource: async (_text, _signal, before) => {
				before?.();
				calls++;
				return "overview";
			},
		}),
	});
	try {
		const folder = engine.store.create(scope, {
			operationId: "folder",
			kind: "collection",
			title: "folder",
			visibility: "private",
		});
		const docs = Array.from({ length: 3 }, (_, i) =>
			engine.store.create(scope, {
				operationId: "doc" + i,
				kind: "document",
				title: "doc" + i,
				visibility: "private",
				parentId: folder.id,
				mediaType: "text/plain",
				bytes: new TextEncoder().encode("source"),
			}),
		);
		const cancelled = new AbortController();
		cancelled.abort(new Error("cancelled by test"));
		await expect(
			engine.runPending(folder.id, cancelled.signal),
		).rejects.toThrow("cancelled by test");
		expect(calls).toBe(0);
		await engine.runPending(folder.id, new AbortController().signal);
		const states = docs.map(
			(d) =>
				engine.store.indexing
					.list(scope, d.id)
					.find((j) => j.kind === "extract")?.state,
		);
		expect(states.filter((s) => s === "ready")).toHaveLength(1);
		expect(states.filter((s) => s === "pending")).toHaveLength(2);
		expect(calls).toBe(1);
		expect(
			engine.store.indexing.read(scope, folder.id, "overview")?.complete,
		).toBe(false);
		await engine.runPending(folder.id, new AbortController().signal);
		expect(calls).toBe(1);
	} finally {
		await engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});
