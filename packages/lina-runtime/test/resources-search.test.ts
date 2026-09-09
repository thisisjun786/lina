import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStore } from "../../lina-memory/src/resources/store.ts";
import { conservativeEstimator } from "../src/context/budget.ts";
import { defaultEnginePolicy } from "../src/context/policy-settings.ts";
import type { ContextServices } from "../src/context/port.ts";
import { ResourceSearch } from "../src/resources/search.ts";

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

test("semantic search traverses a chosen collection and reranks only permitted IDs", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	try {
		const folder = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "운영 기록",
			visibility: "shared",
		});
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "회의 메모",
			parentId: folder.id,
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("늦은 회의를 줄이기로 결정했다"),
		});
		const privateDoc = store.create(scope, {
			operationId: "p",
			kind: "document",
			title: "개인 비밀",
			parentId: folder.id,
			visibility: "private",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		svc.planResources = async (text, _s, before) => {
			before?.();
			expect(text).toContain(folder.id);
			return JSON.stringify({ collectionIds: [folder.id], terms: [] });
		};
		svc.rankResources = async (text, _s, before) => {
			before?.();
			expect(text).toContain(doc.id);
			expect(text).not.toContain(privateDoc.id);
			return JSON.stringify({ ids: [doc.id] });
		};
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		const search = new ResourceSearch({
			store,
			scope: () => other,
			services: () => svc,
			policy: () => policy,
		});
		const result = await search.search(
			{ query: "저녁 시간이 비게 된 이유" },
			new AbortController().signal,
		);
		expect(result.method).toBe("semantic");
		expect(result.items.map((v) => v.id)).toEqual([doc.id]);
		expect(result.calls).toBe(2);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("invented planner IDs produce an explicit lexical fallback", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-invalid-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	try {
		store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "기록",
			visibility: "shared",
		});
		svc.planResources = async (_t, _s, before) => {
			before?.();
			return JSON.stringify({ collectionIds: ["not-offered"], terms: [] });
		};
		svc.rankResources = async () => JSON.stringify({ ids: [] });
		const search = new ResourceSearch({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const result = await search.search(
			{ query: "기록 찾기" },
			new AbortController().signal,
		);
		expect(result.method).toBe("lexical");
		expect(result.incomplete).toBe(true);
		expect(result.reasons).toContain("invalid_model_output");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("search traverses nested collections within the shared call budget", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-depth-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	try {
		const first = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "운영",
			visibility: "shared",
		});
		const second = store.create(scope, {
			operationId: "s",
			kind: "collection",
			title: "회의",
			parentId: first.id,
			visibility: "shared",
		});
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "변경",
			parentId: second.id,
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("원문"),
		});
		svc.planResources = async (text, _s, before) => {
			before?.();
			const ids = JSON.parse(text).collections.map((v: { id: string }) => v.id);
			return JSON.stringify({
				collectionIds: [ids.includes(second.id) ? second.id : first.id],
				terms: [],
			});
		};
		svc.rankResources = async (text, _s, before) => {
			before?.();
			expect(text).toContain(doc.id);
			return JSON.stringify({ ids: [doc.id] });
		};
		const search = new ResourceSearch({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const result = await search.search(
			{ query: "달라진 배경" },
			new AbortController().signal,
		);
		expect(result.items.map((v) => v.id)).toEqual([doc.id]);
		expect(result.calls).toBe(3);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("explicit collection scope cannot expand through planner terms or invalid roots", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-root-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	try {
		const folder = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "허용",
			visibility: "shared",
		});
		const child = store.create(scope, {
			operationId: "c",
			kind: "collection",
			title: "하위",
			parentId: folder.id,
			visibility: "shared",
		});
		const inside = store.create(scope, {
			operationId: "i",
			kind: "document",
			title: "내부",
			parentId: child.id,
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const outside = store.create(scope, {
			operationId: "o",
			kind: "document",
			title: "외부 원문",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const privateFolder = store.create(scope, {
			operationId: "p",
			kind: "collection",
			title: "개인",
			visibility: "private",
		});
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		let calls = 0;
		svc.planResources = async (_t, _s, before) => {
			before?.();
			calls++;
			return JSON.stringify({
				collectionIds: [child.id],
				terms: ["외부 원문"],
			});
		};
		svc.rankResources = async (text, _s, before) => {
			before?.();
			calls++;
			expect(text).not.toContain(outside.id);
			return JSON.stringify({ ids: [inside.id] });
		};
		const search = new ResourceSearch({
			store,
			scope: () => other,
			services: () => ({ ...svc }),
			policy: () => policy,
		});
		expect(
			(
				await search.search(
					{ query: "찾고 싶은 기록", collectionId: folder.id },
					new AbortController().signal,
				)
			).items.map((v) => v.id),
		).toEqual([inside.id]);
		expect(calls).toBe(2);
		await expect(
			search.search(
				{ query: "찾기", collectionId: privateFolder.id },
				new AbortController().signal,
			),
		).rejects.toThrow(/unavailable/);
		await expect(
			search.search(
				{ query: "찾기", collectionId: outside.id },
				new AbortController().signal,
			),
		).rejects.toThrow(/collection/);
		expect(calls).toBe(2);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("short queries stay lexical and scope changes during rank suppress output", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-change-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	let current = scope;
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "개인 기록",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		let calls = 0;
		svc.planResources = async () => {
			calls++;
			return "{}";
		};
		svc.rankResources = async (_t, _s, before) => {
			before?.();
			calls++;
			current = { ...scope, principalId: "agent:b", agentId: "b" };
			return JSON.stringify({ ids: [doc.id] });
		};
		const search = new ResourceSearch({
			store,
			scope: () => current,
			services: () => svc,
			policy: () => policy,
		});
		expect(
			(await search.search({ query: "개인" }, new AbortController().signal))
				.method,
		).toBe("lexical");
		expect(calls).toBe(0);
		const result = await search.search(
			{ query: "개인 기록" },
			new AbortController().signal,
		);
		expect(result.items).toEqual([]);
		expect(result.reasons).toContain("context_changed");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("one-call policy reserves ranking and invalid rank IDs fall back safely", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-budget-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		base = defaultEnginePolicy(),
		policy = { ...base, resources: { ...base.resources, maxCalls: 1 } };
	try {
		store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "운영 기록",
			visibility: "shared",
		});
		let plans = 0,
			ranks = 0;
		svc.planResources = async () => {
			plans++;
			return "{}";
		};
		svc.rankResources = async (_t, _s, before) => {
			before?.();
			ranks++;
			return JSON.stringify({ ids: ["not-offered"] });
		};
		const search = new ResourceSearch({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const result = await search.search(
			{ query: "운영 기록" },
			new AbortController().signal,
		);
		expect(plans).toBe(0);
		expect(ranks).toBe(1);
		expect(result.calls).toBe(1);
		expect(result.method).toBe("lexical");
		expect(result.reasons).toContain("invalid_model_output");
		expect(result.reasons).toContain("call_limit");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("opaque continuation pages reuse rank order without calls and recheck scope", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-search-cursor-")),
		store = new ResourceStore(root, limits),
		svc = services(),
		policy = defaultEnginePolicy();
	let current = scope;
	try {
		const docs = ["a", "b"].map((key) =>
			store.create(scope, {
				operationId: key,
				kind: "document",
				title: `기록 ${key}`,
				visibility: "private",
				mediaType: "text/plain",
				bytes: new Uint8Array(),
			}),
		);
		svc.planResources = async () => "{}";
		svc.rankResources = async (_t, _s, before) => {
			before?.();
			return JSON.stringify({ ids: docs.map((d) => d.id) });
		};
		const search = new ResourceSearch({
			store,
			scope: () => current,
			services: () => svc,
			policy: () => policy,
		});
		const first = await search.search(
			{ query: "기록 찾기", limit: 1 },
			new AbortController().signal,
		);
		if (!first.nextCursor) throw Error("missing cursor");
		const second = await search.search(
			{ query: "기록 찾기", cursor: first.nextCursor, limit: 1 },
			new AbortController().signal,
		);
		const next = docs[1];
		if (!next) throw Error("missing doc");
		expect(second.items.map((d) => d.id)).toEqual([next.id]);
		expect(second.calls).toBe(0);
		expect(second.nextCursor).toBeNull();
		current = { ...scope, principalId: "agent:b", agentId: "b" };
		await expect(
			search.search(
				{ query: "기록 찾기", cursor: first.nextCursor },
				new AbortController().signal,
			),
		).rejects.toThrow(/changed/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("cursor rejects changed derivation coverage even when the text is identical", async () => {
	const root = mkdtempSync(
			join(tmpdir(), "lina-resource-search-cursor-generation-"),
		),
		svc = services(),
		policy = defaultEnginePolicy();
	let generation = {
		policyRevision: 0,
		modelSettingsRevision: 0,
		routeKey: "first",
		estimatorId: "test",
		maxAttempts: 3,
	};
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const docs = ["a", "b"].map((operationId) =>
			store.create(scope, {
				operationId,
				kind: "document",
				title: `자료 ${operationId}`,
				visibility: "shared",
				mediaType: "text/plain",
				bytes: new Uint8Array(),
			}),
		);
		for (const doc of docs) {
			const job = store.indexing
				.list(scope, doc.id)
				.find((j) => j.kind === "brief");
			if (!job) throw Error("missing job");
			store.indexing.complete(
				scope,
				store.indexing.prepare(scope, job.id),
				"same hint",
				true,
			);
		}
		svc.planResources = async () => "{}";
		svc.rankResources = async (_t, _s, before) => {
			before?.();
			return JSON.stringify({ ids: docs.map((d) => d.id) });
		};
		const search = new ResourceSearch({
			store,
			scope: () => scope,
			services: () => svc,
			policy: () => policy,
		});
		const first = await search.search(
			{ query: "자료 찾기", limit: 1 },
			new AbortController().signal,
		);
		if (!first.nextCursor) throw Error("missing cursor");
		generation = { ...generation, routeKey: "second" };
		await expect(
			search.search(
				{ query: "자료 찾기", cursor: first.nextCursor },
				new AbortController().signal,
			),
		).rejects.toThrow(/changed/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
