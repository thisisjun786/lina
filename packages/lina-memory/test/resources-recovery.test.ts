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
for (const [label, sql] of [
	["counter", "UPDATE resources SET revision=9007199254740992"],
	["foreign version", "UPDATE resource_versions SET resource_id='missing'"],
	[
		"receipt identity",
		"UPDATE resource_operations SET principal_id='agent:forged'",
	],
	["receipt result", "UPDATE resource_operations SET result='{}'"],
	["missing version", "DELETE FROM resource_versions"],
	["unknown schema", "PRAGMA user_version=2"],
	["extra schema", "CREATE TABLE foreign_data(id INTEGER)"],
] as const)
	test(`resource reopen refuses corrupt ${label} without rewriting it`, () => {
		const root = mkdtempSync(join(tmpdir(), "lina-resource-corrupt-"));
		try {
			const store = new ResourceStore(root, limits);
			store.create(scope, {
				operationId: "seed",
				kind: "document",
				title: "기록",
				visibility: "private",
				mediaType: "text/plain",
				bytes: new TextEncoder().encode("원문"),
			});
			store.close();
			const db = new DatabaseSync(join(root, "catalog.sqlite"));
			try {
				db.exec("PRAGMA foreign_keys=OFF");
				db.exec(sql);
				const before = db.prepare("SELECT * FROM resource_operations").all();
				expect(() => new ResourceStore(root, limits)).toThrow();
				expect(db.prepare("SELECT * FROM resource_operations").all()).toEqual(
					before,
				);
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

test("secondary collections respect ownership and source deletion", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-resource-alias-"));
	const store = new ResourceStore(root, limits);
	try {
		const folder = store.create(scope, {
			operationId: "f",
			kind: "collection",
			title: "폴더",
			visibility: "shared",
		});
		const doc = store.create(scope, {
			operationId: "d",
			kind: "document",
			title: "문서",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new Uint8Array(),
		});
		store.update(scope, {
			operationId: "alias",
			id: doc.id,
			expectedRevision: 1,
			collectionIds: [folder.id],
		});
		expect(store.list(scope, folder.id).items.map((v) => v.id)).toEqual([
			doc.id,
		]);
		expect(() =>
			store.update(scope, {
				operationId: "restrict",
				id: folder.id,
				expectedRevision: 1,
				visibility: "private",
			}),
		).toThrow(/containment/);
		expect(() =>
			store.update(scope, {
				operationId: "del",
				id: folder.id,
				expectedRevision: 1,
				deleted: true,
			}),
		).toThrow(/containment/);
		store.update(scope, {
			operationId: "unlist",
			id: doc.id,
			expectedRevision: 2,
			collectionIds: [],
		});
		expect(store.list(scope, folder.id).items).toHaveLength(0);
		store.update(scope, {
			operationId: "del",
			id: folder.id,
			expectedRevision: 1,
			deleted: true,
		});
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
