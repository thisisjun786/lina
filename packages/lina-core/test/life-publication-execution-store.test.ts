import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { WorldStore } from "../src/world/store.ts";
import { preparedPublicationFixture } from "./life-publication-prepared-fixture.ts";

test("a real world publication request is scoped, dispatched once, reconciled to a durable decision and reopens unchanged", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-execution-")),
		path = join(root, "world.sqlite"),
		f = preparedPublicationFixture(path);
	try {
		expect(f.prepared.request).not.toHaveProperty("stepId");
		expect(f.prepared.request.input).not.toContain("hidden key");
		expect(
			f.store.dispatchPublicationModel(
				f.lease,
				f.run.id,
				f.job.id,
				f.prepared.request.id,
			).dispatched,
		).toBe(true);
		expect(
			f.store.dispatchPublicationModel(
				f.lease,
				f.run.id,
				f.job.id,
				f.prepared.request.id,
			).dispatched,
		).toBe(false);
		const result = {
			version: 1 as const,
			requestId: f.prepared.request.id,
			inputDigest: f.prepared.inputDigest,
			capabilityFingerprint: f.prepared.capabilityFingerprint,
			nativeReference: f.prepared.nativeReference,
			provider: "synthetic",
			model: "narrator",
			threadId: "synthetic-thread",
			turnId: "synthetic-turn",
			text: '{"kind":"no_post"}',
			usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
			upstreamAttempts: 1 as const,
		};
		f.store.finishPublicationModel(
			f.job.worldId,
			f.job.id,
			f.prepared.request.id,
			{ status: "completed", result },
		);
		const ready = f.store.publicationJob(f.job.worldId, f.job.id);
		expect(ready.status).toBe("ready");
		expect(ready.decision).toEqual({ kind: "no_post" });
		f.store.close();
		const reopened = new WorldStore(path, () => 1000);
		try {
			expect(reopened.publicationJob(f.job.worldId, f.job.id)).toEqual(ready);
		} finally {
			reopened.close();
		}
	} finally {
		f.store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

for (const kind of ["material", "model"] as const)
	test(`reopen rejects rehashed ${kind} that disagrees with its frozen historical source`, () => {
		const root = mkdtempSync(
				join(tmpdir(), "lina-publication-execution-corrupt-"),
			),
			path = join(root, "world.sqlite"),
			f = preparedPublicationFixture(path);
		try {
			f.store.close();
			const db = new DatabaseSync(path);
			try {
				if (kind === "model") {
					const row = db
							.prepare(
								"SELECT record_json FROM life_publication_model_receipts",
							)
							.get(),
						record = JSON.parse(String(row?.["record_json"]));
					record.prepared.request.input = '{"unpermitted":"PRIVATE_RAW_TASK"}';
					record.prepared.inputDigest = lifeDigest(record.prepared.request);
					db.prepare(
						"UPDATE life_publication_model_receipts SET record_json=?,digest=?",
					).run(canonicalLifeJson(record), lifeDigest(record));
				} else {
					for (const table of [
						"life_publication_jobs",
						"life_publication_job_history",
					]) {
						for (const row of db
							.prepare(`SELECT rowid,job_json FROM ${table}`)
							.all()) {
							const job = JSON.parse(String(row["job_json"]));
							if (!job.material) continue;
							job.material.allowedClaims[0].text = "FORGED_HISTORY";
							const { id: _id, digest: _digest, ...body } = job.material;
							const identified = {
								...body,
								id: `material-${lifeDigest(body)}`,
							};
							job.material = { ...identified, digest: lifeDigest(identified) };
							db.prepare(
								`UPDATE ${table} SET job_json=?,digest=? WHERE rowid=?`,
							).run(canonicalLifeJson(job), lifeDigest(job), row["rowid"] ?? 0);
						}
					}
				}
			} finally {
				db.close();
			}
			expect(() => new WorldStore(path, () => 1000).close()).toThrow();
		} finally {
			f.store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
