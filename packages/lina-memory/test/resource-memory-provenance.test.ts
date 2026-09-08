import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { scopeSchema } from "../src/resources/codec.ts";
import { ResourceStore } from "../src/resources/store.ts";

const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 8192,
	maxExtractionBytes: 4096,
};
const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["shared", "private"] as ("shared" | "private")[],
};

test("resource memory schema upgrades valid v1 atomically and preserves source receipts", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-memory-migrate-"));
	try {
		let store = new ResourceStore(root, limits);
		const doc = store.create(scope, {
			operationId: "seed",
			kind: "document",
			title: "Research",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("A source"),
		});
		store.close();
		const db = new DatabaseSync(join(root, "catalog.sqlite"));
		try {
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
			const before = db.prepare("SELECT * FROM resource_operations").all();
			db.exec(
				"DROP TABLE resource_memories; DROP TABLE resource_memory_jobs; DROP TABLE resource_memory_attempts; DROP TABLE resource_memory_intents; PRAGMA user_version=1; UPDATE resource_meta SET value='lina-resources-v1' WHERE key='format'",
			);
			store = new ResourceStore(root, limits);
			expect(store.get(scope, doc.id)).toEqual(doc);
			store.close();
			expect(db.prepare("SELECT * FROM resource_operations").all()).toEqual(
				before,
			);
			expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
			expect(db.prepare("SELECT * FROM resource_meta").all()).toEqual([
				{ key: "format", value: "lina-resources-v2" },
			]);
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unattributed consumers parse shared-only scope and cannot claim private scope", () => {
	expect(
		scopeSchema.parse({
			principalId: "external",
			agentId: null,
			allowedVisibilities: ["shared"],
		}).agentId,
	).toBeNull();
	expect(() => scopeSchema.parse({ ...scope, agentId: null })).toThrow();
});

test("capture is explicit, duplicate completion is stable and source changes hide old memory", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-memory-capture-"));
	let store = new ResourceStore(root, limits);
	try {
		const doc = store.create(scope, {
			operationId: "source",
			kind: "document",
			title: "Research",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("We chose paper because it is portable."),
			deriveMemory: true,
			activityKind: "research",
		});
		const job = store.memories.jobs(scope, doc.id)[0];
		expect(job).toBeDefined();
		if (!job) throw Error("missing job");
		const claim = store.memories.prepare(
			scope,
			job.id,
			"We chose paper because it is portable.",
		);
		const rows = [
			{
				kind: "decision" as const,
				text: "Paper was selected for portability.",
				quote: "because it is portable",
			},
		];
		const result = store.memories.complete(scope, claim, rows);
		expect(result).toHaveLength(1);
		expect(store.memories.complete(scope, claim, rows)).toEqual(result);
		store.close();
		store = new ResourceStore(root, limits);
		expect(store.memories.list(scope, doc.id)).toEqual(result);
		store.update(scope, {
			operationId: "edit",
			id: doc.id,
			expectedRevision: 1,
			bytes: new TextEncoder().encode("The decision changed."),
		});
		expect(store.memories.list(scope, doc.id)).toEqual([]);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("interrupted capture remains unknown across reopen and explicit retry keeps attempts", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-memory-unknown-"));
	let store = new ResourceStore(root, limits);
	try {
		const r = store.create(scope, {
			operationId: "capture",
			kind: "document",
			title: "Notes",
			visibility: "shared",
			mediaType: "text/plain",
			bytes: new TextEncoder().encode("Evidence"),
			deriveMemory: true,
		});
		const j = store.memories.jobs(scope, r.id)[0];
		if (!j) throw Error("job absent");
		const claim = store.memories.prepare(scope, j.id, "Evidence");
		store.close();
		store = new ResourceStore(root, limits);
		expect(store.memories.jobs(scope, r.id)[0]?.state).toBe("prepared");
		store.recoverOwnedState();
		expect(store.memories.jobs(scope, r.id)[0]?.state).toBe("unknown");
		expect(() => store.memories.complete(scope, claim, [])).toThrow();
		store.memories.retry(scope, j.id);
		store.memories.prepare(scope, j.id, "Evidence");
		expect(store.memories.jobs(scope, r.id)[0]?.attempt).toBe(2);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
