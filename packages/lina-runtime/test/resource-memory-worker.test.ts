import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import type { ContextServices } from "../src/context/port.ts";
import {
	memoryGeneration,
	ResourceMemoryWorker,
} from "../src/resources/memory-worker.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["shared", "private"] as ("shared" | "private")[],
};
const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
for (const revoke of [false, true])
	test(`memory worker dispatches standard bounded call and revocation=${revoke}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "lina-memory-worker-")),
			policy = defaultEnginePolicy();
		let calls = 0;
		const svc: ContextServices = {
			estimateText: conservativeEstimator.text,
			estimateMessages: conservativeEstimator.messages,
			estimator: conservativeEstimator,
			systemTokens: 0,
			contextWindow: 32768,
			reserveTokens: 1024,
			summarize: async () => "",
			prepare: () => {
				throw Error("unused");
			},
			memoryInputOverhead: () => 20,
		};
		const store = new ResourceStore(root, limits, undefined, () =>
			memoryGeneration(svc, policy),
		);
		try {
			const r = store.create(scope, {
				operationId: "source",
				kind: "document",
				title: "search",
				visibility: "shared",
				mediaType: "text/plain",
				bytes: new TextEncoder().encode("The source says portable."),
				deriveMemory: true,
				activityKind: "search",
			});
			svc.deriveResourceMemory = async (
				_text,
				_signal,
				before,
				route,
				output,
				input,
			) => {
				before?.();
				calls++;
				expect(route).toEqual({ tier: "standard" });
				expect(output).toBe(policy.resources.outputTokens);
				expect(input).toBe(policy.resources.inputTokens);
				if (revoke)
					store.update(scope, {
						id: r.id,
						operationId: "cancel",
						expectedRevision: 1,
						deriveMemory: false,
					});
				return JSON.stringify([
					{
						kind: "observation",
						text: "Portability was mentioned",
						quote: "portable",
					},
				]);
			};
			const worker = new ResourceMemoryWorker({
				store,
				scope: () => scope,
				services: () => svc,
				policy: () => policy,
			});
			const result = await worker.run(r.id, new AbortController().signal);
			expect(calls).toBe(1);
			expect(result.state).toBe(revoke ? "failed" : "ready");
			expect(store.memories.list(scope, r.id)).toHaveLength(revoke ? 0 : 1);
		} finally {
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

test("ResourceEngine close joins an in-flight memory dispatch before reopening its ledger", async () => {
	const { ResourceEngine } = await import("../src/resources/services.ts");
	const root = mkdtempSync(join(tmpdir(), "lina-memory-close-")),
		policy = defaultEnginePolicy(),
		entered = Promise.withResolvers<void>();
	const svc: ContextServices = {
		estimateText: conservativeEstimator.text,
		estimateMessages: conservativeEstimator.messages,
		estimator: conservativeEstimator,
		systemTokens: 0,
		contextWindow: 32768,
		reserveTokens: 1024,
		summarize: async () => "",
		prepare: () => {
			throw Error("unused");
		},
		memoryInputOverhead: () => 20,
		deriveResourceMemory: async (_text, signal, before) => {
			before?.();
			entered.resolve();
			return new Promise((_resolve, reject) =>
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				}),
			);
		},
	};
	const engine = new ResourceEngine({
		root,
		limits,
		scope: () => scope,
		services: () => svc,
		policy: () => policy,
	});
	try {
		const r = engine.store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "Notes",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("Evidence"),
			deriveMemory: true,
		});
		const running = engine.runPending(r.id, new AbortController().signal);
		await entered.promise;
		await engine.close();
		await running;
		const reopened = new ResourceStore(root, limits, undefined, () =>
			memoryGeneration(svc, policy),
		);
		try {
			const j = reopened.memories.jobs(scope, r.id)[0];
			expect(j?.state).toBe("failed");
			expect(j?.attempt).toBe(1);
		} finally {
			reopened.close();
		}
	} finally {
		await engine.close();
		rmSync(root, { recursive: true, force: true });
	}
});
