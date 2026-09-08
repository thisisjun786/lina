import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LifeSchedulePersistence } from "../src/world/autonomy-schedule.ts";
import { AUTONOMY_SCHEMA } from "../src/world/autonomy-schema.ts";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import {
	PUBLICATION_JOBS_SCHEMA,
	PublicationJobs,
} from "../src/world/publication-jobs.ts";
import {
	PUBLICATION_RUNS_SCHEMA,
	PublicationRuns,
} from "../src/world/publication-runs.ts";
import type { PublicationRun } from "../src/world/publication-types.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-runs-")),
		path = join(root, "world.sqlite"),
		db = new DatabaseSync(path);
	db.exec(
		"CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT;INSERT INTO worlds VALUES('world')",
	);
	db.exec(AUTONOMY_SCHEMA);
	db.exec(PUBLICATION_JOBS_SCHEMA);
	db.exec(PUBLICATION_RUNS_SCHEMA);
	let closed = false;
	const closeDatabase = () => {
		if (!closed) {
			db.close();
			closed = true;
		}
	};
	return {
		db,
		path,
		closeDatabase,
		close() {
			try {
				closeDatabase();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}
const input = {
	requestKey: "run-once",
	expectedConfigRevision: 1,
	expectedSettingsRevision: 1,
	mode: "manual" as const,
};

test.each(["owner", "token"] as const)(
	"reopening rejects rehashed publication lease %s discontinuity",
	(field) => {
		const f = fixture();
		try {
			const jobs = new PublicationJobs(f.db),
				runs = new PublicationRuns(f.db);
			const schedules = new LifeSchedulePersistence(f.db, () => 1000);
			const job = jobs.discover("world", "intent", "lina", "friends");
			const first = schedules.acquire("world", "owner", 1, 100);
			const run = runs.begin(
				"world",
				input,
				[{ jobId: job.id, attemptId: job.attemptId }],
				first,
				null,
			);
			const next =
				field === "owner"
					? schedules.acquire("world", "owner", 1, 50)
					: schedules.acquire("world", "owner", 2, 50);
			const renewed = runs.attachLease("world", run.id, next);
			expect(renewed.lease?.expiresAt).toBe(1050);
			const forged: PublicationRun = structuredClone(renewed);
			if (!forged.lease) throw Error("fixture lease absent");
			if (field === "owner") forged.lease.owner = "foreign";
			else forged.lease.token = first.token;
			for (const table of [
				"life_publication_run_history",
				"life_publication_runs",
			]) {
				f.db
					.prepare(
						`UPDATE ${table} SET run_json=?,digest=? WHERE world_id=? AND run_id=? AND revision=?`,
					)
					.run(
						canonicalLifeJson(forged),
						lifeDigest(forged),
						"world",
						run.id,
						forged.revision,
					);
			}
			f.db
				.prepare(
					"UPDATE life_publication_run_leases SET lease_json=?,digest=? WHERE world_id=? AND run_id=? AND sequence=?",
				)
				.run(
					canonicalLifeJson(forged.lease),
					lifeDigest(forged.lease),
					"world",
					run.id,
					forged.leaseRevision,
				);
			f.closeDatabase();
			const reopened = new DatabaseSync(f.path);
			try {
				expect(() => new PublicationRuns(reopened).validate()).toThrow(
					"Invalid publication run progress history",
				);
			} finally {
				reopened.close();
			}
		} finally {
			f.close();
		}
	},
);
test("a persisted drain key keeps its original ordered attempt batch when later jobs arrive and the response is lost", () => {
	const f = fixture();
	try {
		const jobs = new PublicationJobs(f.db),
			runs = new PublicationRuns(f.db),
			schedules = new LifeSchedulePersistence(f.db, () => 1000);
		const a = jobs.discover("world", "intent-a", "lina", "friends"),
			lease = schedules.acquire("world", "owner", 1, 100);
		const run = runs.begin(
			"world",
			input,
			[{ jobId: a.id, attemptId: a.attemptId }],
			lease,
			null,
		);
		jobs.withhold("world", a.id, "unavailable", true);
		const result = runs.advance("world", run.id, a.id, a.attemptId, "failed");
		expect(result.status).toBe("completed");
		const b = jobs.discover("world", "intent-b", "lina", "friends");
		expect(
			runs.begin(
				"world",
				input,
				[{ jobId: b.id, attemptId: b.attemptId }],
				lease,
				null,
			),
		).toEqual(result);
		f.closeDatabase();
		const db = new DatabaseSync(f.path);
		try {
			const reopened = new PublicationRuns(db);
			reopened.validate();
			expect(reopened.find("world", input.requestKey)).toEqual(result);
			expect(() =>
				reopened.begin(
					"world",
					{ ...input, expectedSettingsRevision: 2 },
					[],
					null,
					null,
				),
			).toThrow();
			expect(new PublicationJobs(db).get("world", b.id).status).toBe("pending");
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

test("empty and blocked runs have receipts and retries cannot absorb newly available work", () => {
	const f = fixture();
	try {
		const runs = new PublicationRuns(f.db);
		const empty = runs.begin("world", input, [], null, null);
		expect(empty.status).toBe("completed");
		const blocked = runs.begin(
			"world",
			{ ...input, requestKey: "blocked" },
			[],
			null,
			"not_configured",
		);
		expect(blocked.status).toBe("blocked");
		expect(
			runs.begin("world", { ...input, requestKey: "blocked" }, [], null, null),
		).toEqual(blocked);
		runs.validate();
	} finally {
		f.close();
	}
});

test("publication-only lease generations and every takeover survive restart and reject a missing or regressed schedule", () => {
	const f = fixture();
	try {
		const jobs = new PublicationJobs(f.db),
			runs = new PublicationRuns(f.db);
		let now = 1000;
		const schedules = new LifeSchedulePersistence(f.db, () => now),
			job = jobs.discover("world", "intent", "lina", "friends");
		const old = schedules.acquire("world", "first", 1, 10),
			run = runs.begin(
				"world",
				input,
				[{ jobId: job.id, attemptId: job.attemptId }],
				old,
				null,
			);
		now = 1011;
		const next = schedules.acquire("world", "next", 1, 10);
		runs.attachLease("world", run.id, next);
		expect(next.token).toBeGreaterThan(old.token);
		expect(() => schedules.assert(old)).toThrow();
		f.closeDatabase();
		const db = new DatabaseSync(f.path);
		try {
			const restored = new LifeSchedulePersistence(db, () => now);
			expect(restored.get("world")?.lease).toEqual(next);
			new PublicationRuns(db).validate();
			db.exec(
				"UPDATE life_schedules SET schedule_json=json_set(schedule_json,'$.leaseSequence',0)",
			);
			expect(() => restored.get("world")).toThrow();
			db.exec("DELETE FROM life_schedules");
			expect(() => restored.get("world")).toThrow("fencing history");
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});

test("missing run lease history is rejected even when the run head and final lease still exist", () => {
	const f = fixture();
	try {
		const jobs = new PublicationJobs(f.db),
			runs = new PublicationRuns(f.db),
			schedules = new LifeSchedulePersistence(f.db, () => 1000),
			job = jobs.discover("world", "intent", "lina", "friends");
		runs.begin(
			"world",
			input,
			[{ jobId: job.id, attemptId: job.attemptId }],
			schedules.acquire("world", "owner", 1, 100),
			null,
		);
		f.db.exec("DELETE FROM life_publication_run_leases");
		f.closeDatabase();
		const db = new DatabaseSync(f.path);
		try {
			expect(() => new PublicationRuns(db).validate()).toThrow();
		} finally {
			db.close();
		}
	} finally {
		f.close();
	}
});
