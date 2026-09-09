import { expect, spyOn, test } from "bun:test";
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

const CATALOG_LIST = "SELECT id FROM resources ORDER BY id";
const RESOURCE_ROW = "SELECT * FROM resources WHERE id=?";

function countQueries(sql: string[], fn: () => void): number[] {
	const original = DatabaseSync.prototype.prepare;
	const counts = sql.map(() => 0);
	const spy = spyOn(DatabaseSync.prototype, "prepare").mockImplementation(
		function (this: DatabaseSync, query: string) {
			const index = sql.indexOf(query);
			if (index >= 0) counts[index] = (counts[index] ?? 0) + 1;
			return original.call(this, query);
		},
	);
	try {
		fn();
		return counts;
	} finally {
		spy.mockRestore();
	}
}

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

test("document writes reuse one catalog snapshot instead of scanning every resource", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-index-scale-"));
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const body = new TextEncoder().encode(
			"shared body reused so all docs dedupe to one blob",
		);
		const ids: string[] = [];
		for (let i = 1; i <= 12; i++) {
			ids.push(
				store.create(scope, {
					operationId: `doc-${i}`,
					kind: "document",
					title: `문서 ${i}`,
					visibility: "private",
					mediaType: "text/plain",
					bytes: body,
				}).id,
			);
		}
		const refresh = countQueries([CATALOG_LIST, RESOURCE_ROW], () => {
			store.indexing.refresh();
		});
		expect(refresh[0]).toBe(1);
		expect(refresh[1]).toBe(12);
		const extra = countQueries([CATALOG_LIST, RESOURCE_ROW], () => {
			ids.push(
				store.create(scope, {
					operationId: "doc-13",
					kind: "document",
					title: "문서 13",
					visibility: "private",
					mediaType: "text/plain",
					bytes: body,
				}).id,
			);
		});
		expect(extra[0]).toBe(2);
		expect(extra[1]).toBe(25);
		const firstId = ids[0];
		if (!firstId) throw Error("missing document");
		const listed = countQueries([CATALOG_LIST], () => {
			const jobs = store.indexing.list(scope, firstId);
			expect(jobs.map((job) => job.kind).sort()).toEqual(["brief", "extract"]);
		});
		expect(listed[0]).toBe(0);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("collection jobs reuse one catalog snapshot and keep membership visibility", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-index-membership-"));
	const store = new ResourceStore(root, limits, () => generation);
	try {
		const body = new TextEncoder().encode("shared body");
		const folder = store.create(scope, {
			operationId: "folder",
			kind: "collection",
			title: "공용",
			visibility: "shared",
		});
		const nested = store.create(scope, {
			operationId: "nested",
			kind: "collection",
			title: "하위",
			visibility: "shared",
			parentId: folder.id,
		});
		const before = store.indexing.list(scope, folder.id)[0];
		if (!before) throw Error("missing overview");
		expect(before.refs.map((ref) => ref.resourceId).sort()).toEqual(
			[folder.id, nested.id].sort(),
		);
		const claim = store.indexing.prepare(scope, before.id);
		const shared = [1, 2, 3, 4].map((i) =>
			store.create(scope, {
				operationId: `shared-${i}`,
				kind: "document",
				title: `공유 ${i}`,
				visibility: "shared",
				parentId: i === 1 ? nested.id : folder.id,
				mediaType: "text/plain",
				bytes: body,
			}),
		);
		const member = store.create(scope, {
			operationId: "member",
			kind: "document",
			title: "멤버",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: body,
		});
		store.update(scope, {
			operationId: "join",
			id: member.id,
			expectedRevision: 1,
			collectionIds: [folder.id],
		});
		const hidden = store.create(scope, {
			operationId: "hidden",
			kind: "document",
			title: "숨김",
			visibility: "private",
			parentId: folder.id,
			mediaType: "text/plain",
			bytes: body,
		});
		expect(store.indexing.complete(scope, claim, "old overview", true)).toBe(
			false,
		);
		const refresh = countQueries([CATALOG_LIST, RESOURCE_ROW], () => {
			store.indexing.refresh();
		});
		expect(refresh[0]).toBe(1);
		expect(refresh[1]).toBe(8);
		const overview = store.indexing.list(scope, folder.id)[0];
		if (!overview) throw Error("missing overview");
		expect(overview.id).not.toBe(before.id);
		expect(overview.refs.map((ref) => ref.resourceId).sort()).toEqual(
			[folder.id, nested.id, member.id, ...shared.map((doc) => doc.id)].sort(),
		);
		expect(overview.refs.some((ref) => ref.resourceId === hidden.id)).toBe(
			false,
		);
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		expect(
			store.indexing
				.list(other, folder.id)[0]
				?.refs.map((ref) => ref.resourceId)
				.sort(),
		).toEqual(overview.refs.map((ref) => ref.resourceId).sort());
		expect(() => store.indexing.list(other, hidden.id)).toThrow(/unavailable/);
		store.update(scope, {
			operationId: "share-hidden",
			id: hidden.id,
			expectedRevision: 1,
			visibility: "shared",
		});
		const afterShare = store.indexing.list(scope, folder.id)[0];
		if (!afterShare) throw Error("missing overview");
		expect(afterShare.id).toBe(overview.id);
		expect(afterShare.refs.some((ref) => ref.resourceId === hidden.id)).toBe(
			false,
		);
		store.update(scope, {
			operationId: "rewrite-hidden",
			id: hidden.id,
			expectedRevision: 2,
			bytes: body,
		});
		const afterRewrite = store.indexing.list(scope, folder.id)[0];
		if (!afterRewrite) throw Error("missing overview");
		expect(afterRewrite.id).not.toBe(overview.id);
		expect(afterRewrite.refs.some((ref) => ref.resourceId === hidden.id)).toBe(
			true,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
