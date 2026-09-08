import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStore } from "../src/resources/store.ts";

const a = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const b = { ...a, principalId: "agent:b", agentId: "b" };
const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
const text = (v: string) => new TextEncoder().encode(v);

test("stable logical references, replay, version history and concurrent CAS survive reopen", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-store-"));
	const first = new ResourceStore(root, limits);
	const second = new ResourceStore(root, limits);
	try {
		const folder = first.create(a, {
			operationId: "folder",
			kind: "collection",
			title: "연구",
			visibility: "shared",
		});
		const input = {
			operationId: "doc",
			kind: "document" as const,
			title: "태양광 자료",
			visibility: "private" as const,
			mediaType: "text/plain",
			bytes: text("원래 결정"),
		};
		const doc = first.create(a, input);
		expect(first.create(a, input)).toEqual(doc);
		expect(() => first.create(a, { ...input, title: "다른 입력" })).toThrow(
			/conflict/,
		);
		const moved = first.update(a, {
			operationId: "move",
			id: doc.id,
			expectedRevision: 1,
			title: "이름 변경",
			parentId: folder.id,
		});
		expect(moved.id).toBe(doc.id);
		expect(() =>
			second.update(a, {
				operationId: "stale",
				id: doc.id,
				expectedRevision: 1,
				title: "덮어쓰기",
			}),
		).toThrow(/stale/);
		const changed = first.update(a, {
			operationId: "content",
			id: doc.id,
			expectedRevision: 2,
			bytes: text("새 결정"),
		});
		expect(
			new TextDecoder().decode(
				first.read(a, doc.id, doc.currentVersion ?? undefined).bytes,
			),
		).toBe("원래 결정");
		expect(() => first.read(b, doc.id)).toThrow(/unavailable/);
		first.close();
		second.close();
		const reopened = new ResourceStore(root, limits);
		try {
			expect(reopened.get(a, doc.id)).toEqual(changed);
			expect(reopened.list(a, folder.id).items.map((v) => v.id)).toEqual([
				doc.id,
			]);
			expect(reopened.list(b, folder.id).items).toEqual([]);
		} finally {
			reopened.close();
		}
	} finally {
		first.close();
		second.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("sharing does not publish private history, and collection restrictions are atomic", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-permission-"));
	const store = new ResourceStore(root, limits);
	try {
		const folder = store.create(a, {
			operationId: "f",
			kind: "collection",
			title: "공용",
			visibility: "shared",
		});
		const doc = store.create(a, {
			operationId: "d",
			kind: "document",
			title: "비공개",
			visibility: "private",
			parentId: folder.id,
			mediaType: "text/plain",
			bytes: text("비밀"),
		});
		store.update(a, {
			operationId: "share",
			id: doc.id,
			expectedRevision: 1,
			visibility: "shared",
			bytes: text("공개본"),
		});
		expect(() =>
			store.read(b, doc.id, doc.currentVersion ?? undefined),
		).toThrow(/unavailable/);
		expect(new TextDecoder().decode(store.read(b, doc.id).bytes)).toBe(
			"공개본",
		);
		expect(() =>
			store.update(b, {
				operationId: "take",
				id: doc.id,
				expectedRevision: 2,
				visibility: "private",
			}),
		).toThrow(/owner/);
		expect(() =>
			store.update(a, {
				operationId: "hide-folder",
				id: folder.id,
				expectedRevision: 1,
				visibility: "private",
			}),
		).toThrow(/containment/);
		expect(store.get(a, folder.id).visibility).toBe("shared");
		expect(() =>
			store.update(a, {
				operationId: "cycle",
				id: folder.id,
				expectedRevision: 1,
				parentId: folder.id,
			}),
		).toThrow(/cycle/);
		store.update(a, {
			operationId: "delete",
			id: doc.id,
			expectedRevision: 2,
			deleted: true,
		});
		expect(() =>
			store.read(a, doc.id, doc.currentVersion ?? undefined),
		).toThrow(/unavailable/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
