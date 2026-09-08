import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResourceStore } from "../src/resources/store.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
const generation = {
	policyRevision: 1,
	modelSettingsRevision: 1,
	routeKey: "route1",
	estimatorId: "test",
	maxAttempts: 3,
};

test("ingest queues durable jobs and restart rejects a late claimed result", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-jobs-"));
	let store = new ResourceStore(root, limits, () => generation);
	try {
		const doc = store.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "기록",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("에너지 연구"),
		});
		const jobs = store.indexing.list(scope, doc.id);
		expect(jobs.map((j) => j.kind).sort()).toEqual(["brief", "extract"]);
		const job = jobs.find((j) => j.kind === "extract");
		if (!job) throw Error("missing job");
		const claim = store.indexing.prepare(scope, job.id);
		store.close();
		store = new ResourceStore(root, limits, () => generation);
		expect(store.indexing.get(scope, job.id).state).toBe("prepared");
		expect(store.indexing.recoverInterrupted()).toBe(1);
		expect(() => store.indexing.complete(scope, claim, "late", true)).toThrow(
			/claim/,
		);
		expect(store.indexing.get(scope, job.id).state).toBe("unknown");
		store.indexing.retry(scope, job.id);
		const second = store.indexing.prepare(scope, job.id);
		store.indexing.complete(scope, second, "에너지 연구", true);
		expect(store.indexing.read(scope, doc.id, "extract")?.text).toBe(
			"에너지 연구",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("source edits and permission changes suppress derived text", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-stale-"));
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const doc = store.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "기록",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const job = store.indexing
			.list(scope, doc.id)
			.find((j) => j.kind === "brief");
		if (!job) throw Error("missing job");
		const claim = store.indexing.prepare(scope, job.id);
		store.update(scope, {
			operationId: "edit",
			id: doc.id,
			expectedRevision: 1,
			title: "수정",
		});
		expect(store.indexing.complete(scope, claim, "old title", true)).toBe(
			false,
		);
		expect(store.indexing.read(scope, doc.id, "brief")).toBeUndefined();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("generation changes create new jobs without resetting consumed attempts", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-generations-"));
	let current = { ...generation };
	const store = new ResourceStore(root, limits, () => current);
	try {
		const doc = store.create(scope, {
			operationId: "doc",
			kind: "document",
			title: "기록",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		for (let i = 0; i < 3; i++) {
			store.indexing.refresh();
			const job = store.indexing
				.list(scope, doc.id)
				.find(
					(j) =>
						j.kind === "brief" && j.generation.routeKey === current.routeKey,
				);
			if (!job) throw Error("missing generation");
			const claim = store.indexing.prepare(scope, job.id);
			store.indexing.fail(claim, "provider_failed");
			current = { ...current, routeKey: `route${i + 2}` };
		}
		store.indexing.refresh();
		const job = store.indexing
			.list(scope, doc.id)
			.find(
				(j) => j.kind === "brief" && j.generation.routeKey === current.routeKey,
			);
		if (!job) throw Error("missing generation");
		expect(() => store.indexing.prepare(scope, job.id)).toThrow(/exhausted/);
		expect(store.indexing.get(scope, job.id).state).toBe("exhausted");
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("shared collection jobs never include private child identities", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-overview-"));
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const folder = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "공용",
			visibility: "shared",
		});
		const before = store.indexing.list(scope, folder.id);
		const privateDoc = store.create(scope, {
			operationId: "secret",
			kind: "document",
			title: "숨긴 문서",
			visibility: "private",
			parentId: folder.id,
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		expect(store.indexing.list(other, folder.id)).toEqual(before);
		expect(JSON.stringify(before)).not.toContain(privateDoc.id);
		expect(() => store.indexing.list(other, privateDoc.id)).toThrow(
			/unavailable/,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("sharing a collection creates a new shared job while private document versions stay excluded", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-share-index-"));
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const folder = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "폴더",
			visibility: "private",
		});
		const old = store.indexing.list(scope, folder.id)[0];
		if (!old) throw Error("missing job");
		store.update(scope, {
			operationId: "sharef",
			id: folder.id,
			expectedRevision: 1,
			visibility: "shared",
		});
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		const current = store.indexing.list(other, folder.id)[0];
		if (!current) throw Error("missing shared job");
		expect(current.id).not.toBe(old.id);
		expect(current.visibility).toBe("shared");
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "기록",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("SECRET"),
		});
		store.update(scope, {
			operationId: "shared",
			id: doc.id,
			expectedRevision: 1,
			visibility: "shared",
		});
		const job = store.indexing
			.list(scope, doc.id)
			.find((j) => j.kind === "extract");
		if (!job) throw Error("missing job");
		expect(() => store.indexing.prepare(scope, job.id)).toThrow(/stale/);
		expect(store.indexing.get(scope, job.id).attempt).toBe(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("generation-only changes label navigation hints stale, source changes hide them", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-hint-"));
	let current = { ...generation };
	const store = new ResourceStore(root, limits, () => current);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "기록",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const job = store.indexing
			.list(scope, doc.id)
			.find((j) => j.kind === "brief");
		if (!job) throw Error("missing job");
		store.indexing.complete(
			scope,
			store.indexing.prepare(scope, job.id),
			"탐색 힌트",
			true,
		);
		current = { ...current, routeKey: "route-next" };
		expect(store.indexing.read(scope, doc.id, "brief")?.stale).toBe(true);
		store.update(scope, {
			operationId: "change",
			id: doc.id,
			expectedRevision: 1,
			title: "다른 근거",
		});
		expect(store.indexing.read(scope, doc.id, "brief")).toBeUndefined();
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("ready derivations reopen and corrupted output receipts are rejected", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-derived-reopen-"));
	let store = new ResourceStore(root, limits, () => generation);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "기록",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const job = store.indexing
			.list(scope, doc.id)
			.find((j) => j.kind === "extract");
		if (!job) throw Error("missing job");
		store.indexing.complete(
			scope,
			store.indexing.prepare(scope, job.id),
			"원문",
			true,
		);
		store.close();
		store = new ResourceStore(root, limits, () => generation);
		expect(store.indexing.read(scope, doc.id, "extract")?.text).toBe("원문");
		store.close();
		const db = new DatabaseSync(join(root, "catalog.sqlite"));
		try {
			db.exec(
				"UPDATE resource_derivations SET data=json_set(data,'$.text','forged')",
			);
		} finally {
			db.close();
		}
		expect(() => new ResourceStore(root, limits, () => generation)).toThrow(
			/corrupt/,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
