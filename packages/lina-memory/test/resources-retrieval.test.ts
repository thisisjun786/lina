import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResource } from "../src/resources/retrieval.ts";
import { ResourceStore } from "../src/resources/store.ts";

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

test("source-linked text paging preserves Unicode and binary originals are descriptors", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-pages-"));
	const store = new ResourceStore(root, limits);
	try {
		const original = "결정😀반복🫖".repeat(4);
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "원문",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode(original),
		});
		let offset = 0,
			restored = "";
		do {
			const page = readResource(store, scope, doc.id, {
				level: "content",
				offset,
				limit: 5,
			});
			expect(page.text?.isWellFormed()).toBe(true);
			restored += page.text;
			offset = page.nextOffset ?? -1;
		} while (offset >= 0);
		expect(restored).toBe(original);
		const image = store.create(scope, {
			operationId: "i",
			kind: "document",
			title: "원본",
			visibility: "private",
			mediaType: "image/png",
			bytes: new Uint8Array([1, 2, 3]),
		});
		const page = readResource(store, scope, image.id, { level: "content" });
		expect(page.text).toBeNull();
		expect(page.status).toBe("unavailable");
		expect(page.original?.byteLength).toBe(3);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("find filters private and stale FTS candidates before returning metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-find-"));
	const store = new ResourceStore(root, limits);
	try {
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "문서",
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
			"태양광 발전 evidence",
			true,
		);
		expect(store.find(scope, "태양광").map((r) => r.id)).toEqual([doc.id]);
		const secret = store.create(scope, {
			operationId: "s",
			kind: "document",
			title: "태양광 비밀",
			visibility: "private",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		const other = { ...scope, principalId: "agent:b", agentId: "b" };
		expect(store.find(other, "태양광").map((r) => r.id)).not.toContain(
			secret.id,
		);
		store.update(scope, {
			operationId: "edit",
			id: doc.id,
			expectedRevision: 1,
			bytes: new TextEncoder().encode("wind"),
		});
		expect(store.find(other, "태양광")).toEqual([]);
		expect(store.find(scope, "문").map((r) => r.id)).toEqual([doc.id]);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
