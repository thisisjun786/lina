import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	PUBLICATION_JOBS_SCHEMA,
	PublicationJobs,
} from "../src/world/publication-jobs.ts";

test("job discovery is once-only across reopen, retry needs explicit known failure and changed identity conflicts", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-jobs-")),
		path = join(root, "world.sqlite");
	let db = new DatabaseSync(path);
	try {
		db.exec(
			"PRAGMA foreign_keys=ON; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world')",
		);
		db.exec(PUBLICATION_JOBS_SCHEMA);
		let jobs = new PublicationJobs(db);
		const job = jobs.discover("world", "intent", "lina", "friends");
		expect(jobs.discover("world", "intent", "lina", "friends")).toEqual(job);
		expect(job.status).toBe("pending");
		expect(() =>
			jobs.retry("world", job.id, {
				requestKey: "retry",
				expectedRevision: job.revision,
			}),
		).toThrow();
		const failed = jobs.withhold("world", job.id, "unavailable", true);
		const retry = jobs.retry("world", job.id, {
			requestKey: "retry",
			expectedRevision: failed.revision,
		});
		expect(retry.attempt).toBe(2);
		expect(retry.attemptId).not.toBe(job.attemptId);
		db.close();
		db = new DatabaseSync(path);
		jobs = new PublicationJobs(db);
		jobs.validate();
		expect(jobs.get("world", job.id)).toEqual(retry);
		expect(
			jobs.retry("world", job.id, {
				requestKey: "retry",
				expectedRevision: failed.revision,
			}),
		).toEqual(retry);
		expect(() =>
			jobs.retry("world", job.id, {
				requestKey: "retry",
				expectedRevision: retry.revision,
			}),
		).toThrow();
		expect(jobs.list("world")).toHaveLength(1);
		expect(() => jobs.get("other", job.id)).toThrow();
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["missing", "duplicate"] as const)(
	"reopening rejects a %s retry request even when the attempt history is intact",
	(kind) => {
		const root = mkdtempSync(join(tmpdir(), "lina-publication-retry-proof-"));
		const path = join(root, "world.sqlite");
		let db = new DatabaseSync(path);
		try {
			db.exec(
				"CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world')",
			);
			db.exec(PUBLICATION_JOBS_SCHEMA);
			const jobs = new PublicationJobs(db);
			const job = jobs.discover("world", "intent", "lina", "friends");
			const failed = jobs.withhold("world", job.id, "unavailable", true);
			jobs.retry("world", job.id, {
				requestKey: "retry",
				expectedRevision: failed.revision,
			});
			if (kind === "missing")
				db.exec("DELETE FROM life_publication_job_requests");
			else
				db.prepare(
					"INSERT INTO life_publication_job_requests SELECT world_id,?,job_id,expected_revision,result_revision,? FROM life_publication_job_requests",
				).run(
					"duplicate",
					lifeDigest({
						jobId: job.id,
						requestKey: "duplicate",
						expectedRevision: failed.revision,
					}),
				);
			db.close();
			db = new DatabaseSync(path);
			expect(() => new PublicationJobs(db).validate()).toThrow(
				"publication retry receipt",
			);
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("job history cannot disappear, regress or change to a forged terminal receipt on actual reopen", () => {
	for (const sql of [
		"DELETE FROM life_publication_jobs",
		"UPDATE life_publication_jobs SET revision=9007199254740992",
		"DELETE FROM life_publication_job_history WHERE revision=1",
		"UPDATE life_publication_job_history SET digest='bad'",
	]) {
		const root = mkdtempSync(join(tmpdir(), "lina-publication-job-corrupt-")),
			path = join(root, "world.sqlite");
		let db = new DatabaseSync(path);
		try {
			db.exec(
				"PRAGMA foreign_keys=OFF; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world')",
			);
			db.exec(PUBLICATION_JOBS_SCHEMA);
			const jobs = new PublicationJobs(db),
				job = jobs.discover("world", "intent", "lina", "friends");
			jobs.withhold("world", job.id, "unavailable", true);
			db.exec(sql);
			db.close();
			db = new DatabaseSync(path);
			expect(() => new PublicationJobs(db).validate()).toThrow();
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
});
