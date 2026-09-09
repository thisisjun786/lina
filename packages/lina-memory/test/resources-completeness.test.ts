import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJob, writeJob } from "../src/resources/job-records.ts";
import { ResourceStore } from "../src/resources/store.ts";

const scope = {
	principalId: "agent:a",
	agentId: "a",
	allowedVisibilities: ["private", "shared"] as ("private" | "shared")[],
};
const limits = {
	maxFileBytes: 4096,
	maxCatalogBytes: 32768,
	maxExtractionBytes: 4096,
};
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-coverage-"));
	const open = () => new ResourceStore(root, limits);
	const store = open();
	try {
		const folder = store.create(scope, {
			operationId: "folder",
			kind: "collection",
			title: "folder",
			visibility: "shared",
		});
		const docs = [];
		for (let i = 0; i < 64; i++)
			docs.push(
				store.create(scope, {
					operationId: `d${i}`,
					kind: "document",
					title: `d${i}`,
					visibility: "shared",
					mediaType: "text/plain",
					bytes: new TextEncoder().encode("source"),
				}),
			);
		docs.sort((a, b) => (a.id < b.id ? -1 : 1));
		for (const doc of docs.slice(0, 63))
			store.update(scope, {
				operationId: `link-${doc.id}`,
				id: doc.id,
				expectedRevision: doc.revision,
				collectionIds: [folder.id],
			});
		const extra = docs[63];
		if (!extra) throw Error("missing extra");
		const job = store.indexing.list(scope, folder.id)[0];
		if (!job) throw Error("missing overview");
		return {
			root,
			store,
			open,
			folder,
			extra,
			job,
			close() {
				store.close();
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		store.close();
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
for (const intrinsicComplete of [true, false])
	test(`unchanged selected refs reflect overflow and removal without promoting partial output (${intrinsicComplete})`, () => {
		const f = fixture();
		try {
			expect(f.job.refs).toHaveLength(64);
			expect(f.job.complete).toBe(true);
			const claim = f.store.indexing.prepare(scope, f.job.id);
			expect(
				f.store.indexing.complete(scope, claim, "summary", intrinsicComplete),
			).toBe(true);
			const original = f.store.indexing.get(scope, f.job.id);
			const added = f.store.update(scope, {
				operationId: "overflow",
				id: f.extra.id,
				expectedRevision: 1,
				collectionIds: [f.folder.id],
			});
			const current = f.store.indexing.list(scope, f.folder.id)[0];
			expect(current).toMatchObject({
				id: original.id,
				refs: original.refs,
				complete: false,
				state: "ready",
				attempt: 1,
				outputHash: original.outputHash,
			});
			expect(f.store.affectedResources(added)).toContain(f.folder.id);
			expect(
				f.store.indexing.read(scope, f.folder.id, "overview"),
			).toMatchObject({ text: "summary", complete: false, stale: false });
			f.store.update(scope, {
				operationId: "remove-extra",
				id: f.extra.id,
				expectedRevision: added.revision,
				collectionIds: [],
			});
			expect(
				f.store.indexing.read(scope, f.folder.id, "overview")?.complete,
			).toBe(intrinsicComplete);
			expect(f.store.indexing.get(scope, f.job.id)).toMatchObject({
				id: original.id,
				state: "ready",
				attempt: 1,
				outputHash: original.outputHash,
			});
			f.store.close();
			const reopened = f.open();
			try {
				expect(
					reopened.indexing.read(scope, f.folder.id, "overview")?.complete,
				).toBe(intrinsicComplete);
			} finally {
				reopened.close();
			}
		} finally {
			f.close();
		}
	});

test("coverage changes preserve a prepared claim but gate its committed completeness", () => {
	const f = fixture();
	try {
		const claim = f.store.indexing.prepare(scope, f.job.id);
		f.store.update(scope, {
			operationId: "overflow",
			id: f.extra.id,
			expectedRevision: 1,
			collectionIds: [f.folder.id],
		});
		expect(f.store.indexing.get(scope, f.job.id)).toMatchObject({
			state: "prepared",
			token: claim.token,
			attempt: 1,
			complete: false,
		});
		expect(f.store.indexing.complete(scope, claim, "late summary", true)).toBe(
			true,
		);
		expect(
			f.store.indexing.read(scope, f.folder.id, "overview")?.complete,
		).toBe(false);
	} finally {
		f.close();
	}
});

test("legacy untouched job coverage is projected on read without rewriting its receipt", () => {
	const f = fixture();
	try {
		const claim = f.store.indexing.prepare(scope, f.job.id);
		f.store.indexing.complete(scope, claim, "legacy summary", true);
		f.store.update(scope, {
			operationId: "overflow",
			id: f.extra.id,
			expectedRevision: 1,
			collectionIds: [f.folder.id],
		});
		f.store.close();
		const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
		try {
			const job = readJob(db, f.job.id);
			if (!job) throw Error("missing saved job");
			// This is the valid legacy representation: coverage was excluded from job identity.
			db.exec("BEGIN IMMEDIATE");
			writeJob(db, { ...job, complete: true });
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		const reopened = f.open();
		try {
			const original = reopened.indexing.get(scope, f.job.id);
			expect(reopened.indexing.list(scope, f.folder.id)[0]).toMatchObject({
				complete: false,
				id: f.job.id,
			});
			expect(
				reopened.indexing.read(scope, f.folder.id, "overview"),
			).toMatchObject({
				complete: false,
				text: "legacy summary",
				stale: false,
			});
			expect(reopened.indexing.get(scope, f.job.id).outputHash).toBe(
				original.outputHash,
			);
		} finally {
			reopened.close();
		}
	} finally {
		f.close();
	}
});

test("prepare and retry refresh legacy pending coverage without resetting attempts", () => {
	const f = fixture();
	try {
		f.store.update(scope, {
			operationId: "overflow",
			id: f.extra.id,
			expectedRevision: 1,
			collectionIds: [f.folder.id],
		});
		const legacyCoverage = () => {
			const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
			try {
				const job = readJob(db, f.job.id);
				if (!job) throw Error("missing job");
				db.exec("BEGIN IMMEDIATE");
				writeJob(db, { ...job, complete: true });
				db.exec("COMMIT");
			} finally {
				db.close();
			}
		};
		legacyCoverage();
		const first = f.store.indexing.prepare(scope, f.job.id);
		expect(f.store.indexing.get(scope, f.job.id)).toMatchObject({
			state: "prepared",
			attempt: 1,
			complete: false,
		});
		f.store.indexing.fail(first, "cancelled");
		legacyCoverage();
		f.store.indexing.retry(scope, f.job.id);
		expect(f.store.indexing.get(scope, f.job.id)).toMatchObject({
			state: "pending",
			attempt: 1,
			complete: false,
		});
		const second = f.store.indexing.prepare(scope, f.job.id);
		expect(second.token).not.toBe(first.token);
		expect(f.store.indexing.get(scope, f.job.id).attempt).toBe(2);
		expect(() =>
			f.store.indexing.complete(scope, first, "obsolete", true),
		).toThrow(/claim/);
		expect(f.store.indexing.complete(scope, second, "summary", true)).toBe(
			true,
		);
		expect(
			f.store.indexing.read(scope, f.folder.id, "overview")?.complete,
		).toBe(false);
	} finally {
		f.close();
	}
});

test("read-time incomplete projection never masks a corrupted output receipt", () => {
	const f = fixture();
	try {
		const claim = f.store.indexing.prepare(scope, f.job.id);
		f.store.indexing.complete(scope, claim, "summary", true);
		f.store.update(scope, {
			operationId: "overflow",
			id: f.extra.id,
			expectedRevision: 1,
			collectionIds: [f.folder.id],
		});
		const db = new DatabaseSync(join(f.root, "catalog.sqlite"));
		try {
			const row = db
				.prepare("SELECT data FROM resource_derivations WHERE resource_id=?")
				.get(f.folder.id);
			const output = JSON.parse(String(row?.["data"]));
			db.prepare(
				"UPDATE resource_derivations SET data=? WHERE resource_id=?",
			).run(JSON.stringify({ ...output, complete: false }), f.folder.id);
		} finally {
			db.close();
		}
		expect(() => f.store.indexing.read(scope, f.folder.id, "overview")).toThrow(
			"corrupt resource derivation",
		);
	} finally {
		f.close();
	}
});
