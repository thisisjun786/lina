import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import type { ContextServices } from "../src/context/port.ts";
import { ResourceWorker, resourceGeneration } from "../src/resources/worker.ts";

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
function services(): ContextServices {
	return {
		estimator: conservativeEstimator,
		estimateText: conservativeEstimator.text,
		estimateMessages: conservativeEstimator.messages,
		systemTokens: 0,
		contextWindow: 32768,
		reserveTokens: 1024,
		summarize: async () => "unused",
		prepare: () => {
			throw Error("unused");
		},
		resourceInputOverhead: () => 20,
	};
}

test("worker performs extraction then bounded summary and persists actual dispatch claim", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-")),
		policy = defaultEnginePolicy(),
		svc = services();
	let calls = 0,
		cap: number | undefined;
	svc.summarizeResource = async (text, _signal, before, _route, maxTokens) => {
		before?.();
		calls++;
		cap = maxTokens;
		expect(text).toContain("근거 원문");
		return "자료 요약";
	};
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, policy, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("근거 원문"),
		});
		const worker = new ResourceWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const extract = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "extract"),
			brief = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "brief");
		if (!extract || !brief) throw Error("missing jobs");
		expect(
			(await worker.run(extract.id, new AbortController().signal)).state,
		).toBe("ready");
		expect(
			(await worker.run(brief.id, new AbortController().signal)).state,
		).toBe("ready");
		expect(calls).toBe(1);
		expect(cap).toBe(policy.resources.outputTokens);
		expect(store.indexing.read(scope, doc.id, "brief")?.text).toBe("자료 요약");
		expect(store.indexing.get(scope, brief.id).inputHash).toMatch(
			/^[a-f0-9]{64}$/,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker does not consume an attempt when source changes before dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-guard-")),
		policy = defaultEnginePolicy(),
		svc = services();
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, policy, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const worker = new ResourceWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const extract = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "extract"),
			brief = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "brief");
		if (!extract || !brief) throw Error("missing jobs");
		await worker.run(extract.id, new AbortController().signal);
		svc.summarizeResource = async (_text, _s, before) => {
			store.update(scope, {
				operationId: "restrict",
				id: doc.id,
				expectedRevision: 1,
				visibility: "private",
			});
			before?.();
			return "not delivered";
		};
		expect(
			(await worker.run(brief.id, new AbortController().signal)).state,
		).not.toBe("ready");
		expect(store.indexing.get(scope, brief.id).attempt).toBe(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("post-dispatch cancellation persists a consumed failed attempt", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-cancel-")),
		policy = defaultEnginePolicy(),
		svc = services();
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, policy, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const worker = new ResourceWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const jobs = store.indexing.list(scope, doc.id),
			extract = jobs.find((j) => j.kind === "extract"),
			brief = jobs.find((j) => j.kind === "brief");
		if (!extract || !brief) throw Error("missing jobs");
		await worker.run(extract.id, new AbortController().signal);
		const abort = new AbortController();
		svc.summarizeResource = async (_t, _s, before) => {
			before?.();
			abort.abort();
			return "late";
		};
		expect(await worker.run(brief.id, abort.signal)).toMatchObject({
			state: "failed",
			error: "cancelled",
		});
		expect(store.indexing.get(scope, brief.id)).toMatchObject({
			attempt: 1,
			state: "failed",
			error: "cancelled",
		});
		expect(store.indexing.read(scope, doc.id, "brief")).toBeUndefined();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("invalid text is terminal and disabled summaries consume no attempts", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-disabled-")),
		policy = defaultEnginePolicy(),
		svc = services();
	const disabled = {
		...policy,
		resources: { ...policy.resources, enabled: false },
	};
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, disabled, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array([255]),
		});
		const worker = new ResourceWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => disabled,
		});
		const jobs = store.indexing.list(scope, doc.id),
			extract = jobs.find((j) => j.kind === "extract"),
			brief = jobs.find((j) => j.kind === "brief");
		if (!extract || !brief) throw Error("missing jobs");
		expect(
			await worker.run(extract.id, new AbortController().signal),
		).toMatchObject({ state: "unavailable", error: "undecodable_text" });
		expect(store.indexing.get(scope, extract.id).error).toBe(
			"undecodable_text",
		);
		expect(
			await worker.run(brief.id, new AbortController().signal),
		).toMatchObject({ state: "unavailable", error: "policy_disabled" });
		expect(store.indexing.get(scope, brief.id).attempt).toBe(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker exposes exhausted storage state without inventing a provider failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-exhausted-")),
		policy = defaultEnginePolicy(),
		svc = services();
	let key = "first";
	svc.summaryCacheKey = () => key;
	svc.summarizeResource = async (_t, _s, before) => {
		before?.();
		return "summary";
	};
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, policy, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "자료",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const worker = new ResourceWorker({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const jobs = store.indexing.list(scope, doc.id),
			extract = jobs.find((j) => j.kind === "extract"),
			brief = jobs.find((j) => j.kind === "brief");
		if (!extract || !brief) throw Error("missing jobs");
		await worker.run(extract.id, new AbortController().signal);
		for (let i = 0; i < 3; i++) {
			store.indexing.fail(
				store.indexing.prepare(scope, brief.id),
				"provider_failed",
			);
			if (i < 2) store.indexing.retry(scope, brief.id);
		}
		key = "second";
		store.indexing.refresh();
		const next = store.indexing
			.list(scope, doc.id)
			.find((j) => j.kind === "brief" && j.state === "pending");
		if (!next) throw Error("missing job");
		expect(
			await worker.run(next.id, new AbortController().signal),
		).toMatchObject({ state: "exhausted", error: "attempts_exhausted" });
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("oversized vision output is rejected and classified as invalid output", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-worker-vision-")),
		policy = defaultEnginePolicy(),
		svc = services();
	svc.analyzeImage = async (_i, _s, before, max) => {
		before?.();
		expect(max).toBe(policy.resources.outputTokens);
		return { provider: "fake", model: "fake", text: "X".repeat(20000) };
	};
	const store = new ResourceStore(root, limits, (kind) =>
		resourceGeneration(svc, policy, kind),
	);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "이미지",
			visibility: "shared",
			mediaType: "image/png",
			bytes: new Uint8Array([1]),
		});
		const worker = new ResourceWorker({
				store,
				scope: () => scope,
				services: () => svc,
				policy: () => policy,
			}),
			job = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "extract");
		if (!job) throw Error("missing job");
		expect(
			await worker.run(job.id, new AbortController().signal),
		).toMatchObject({ state: "failed", error: "invalid_output" });
		expect(store.indexing.get(scope, job.id).error).toBe("invalid_output");
		expect(store.indexing.read(scope, doc.id, "extract")).toBeUndefined();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
