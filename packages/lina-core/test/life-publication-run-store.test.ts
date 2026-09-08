import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PublicationJobs } from "../src/world/publication-jobs.ts";
import { WorldStore } from "../src/world/store.ts";
import { publicationStoreFixture as fixture } from "./life-publication-store-fixture.ts";

const input = {
	requestKey: "publication-run",
	expectedConfigRevision: 1,
	expectedSettingsRevision: 1,
	mode: "automatic" as const,
};

test("startup rejects an unadvanced run whose referenced attempt was replaced in storage", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-attempt-history-")),
		path = join(root, "world.sqlite");
	const store = fixture(path);
	try {
		const run = store.beginPublicationRun("test-world", input, "owner", 100),
			item = run.batch[0];
		if (!run.lease || !item) throw Error("fixture run absent");
		const failed = store.failPublicationJob(
			run.lease,
			run.id,
			item.jobId,
			"unavailable",
		);
		store.close();
		const db = new DatabaseSync(path);
		try {
			new PublicationJobs(db).retry("test-world", item.jobId, {
				requestKey: "invalid-order",
				expectedRevision: failed.revision,
			});
		} finally {
			db.close();
		}
		expect(() => new WorldStore(path)).toThrow(
			"Unadvanced publication run attempt changed",
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a failed attempt must be advanced before retry, including a restart between failure and advancement", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-retry-run-")),
		path = join(root, "world.sqlite");
	let store = fixture(path);
	try {
		const run = store.beginPublicationRun("test-world", input, "owner", 100);
		const item = run.batch[0];
		if (!run.lease || !item) throw Error("fixture run absent");
		const failed = store.failPublicationJob(
			run.lease,
			run.id,
			item.jobId,
			"unavailable",
		);
		store.close();
		store = new WorldStore(path, () => 1200);
		const retry = { requestKey: "retry", expectedRevision: failed.revision };
		expect(() =>
			store.retryPublicationJob("test-world", item.jobId, retry),
		).toThrow("Advance the publication run before retry");
		expect(store.publicationJob("test-world", item.jobId)).toEqual(failed);
		const resumed = store.beginPublicationRun(
			"test-world",
			input,
			"resumer",
			100,
		);
		if (!resumed.lease) throw Error("fixture lease absent");
		expect(
			store.advancePublicationRun(resumed.lease, resumed.id, item.jobId).status,
		).toBe("completed");
		const next = store.retryPublicationJob("test-world", item.jobId, retry);
		expect(next.attempt).toBe(failed.attempt + 1);
		const later = store.beginPublicationRun(
			"test-world",
			{ ...input, requestKey: "next-run" },
			"resumer",
			100,
		);
		expect(later.status).toBe("running");
		expect(later.batch).toEqual([
			{ jobId: item.jobId, attemptId: next.attemptId },
		]);
		expect(store.retryPublicationJob("test-world", item.jobId, retry)).toEqual(
			next,
		);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
test("publication-only automatic work runs while simulation is manual, with one shared world lease and a fixed batch", () => {
	const store = fixture();
	try {
		const run = store.beginPublicationRun("test-world", input, "runner", 100);
		expect(run.status).toBe("running");
		expect(run.batch).toHaveLength(1);
		expect(run.lease?.owner).toBe("runner");
		expect(
			store.beginPublicationRun("test-world", input, "runner", 100).batch,
		).toEqual(run.batch);
		expect(() =>
			store.beginPublicationRun(
				"test-world",
				{ ...input, expectedSettingsRevision: 2 },
				"runner",
				100,
			),
		).toThrow();
		expect(
			store.beginPublicationRun(
				"test-world",
				{ ...input, requestKey: "competing" },
				"foreign",
				100,
			).blocked,
		).toBe("pending_run");
		expect(
			store.publicationJob("test-world", run.batch[0]?.jobId ?? "")
				.authorAgentId,
		).toBe("lina");
	} finally {
		store.close();
	}
});

test("a blocked fresh run cannot take over the expired lease of an unfinished run after restart", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-publication-pending-"));
	const path = join(root, "world.sqlite");
	let store = fixture(path);
	let db: DatabaseSync | undefined;
	try {
		const run = store.beginPublicationRun("test-world", input, "first", 100);
		store.close();
		store = new WorldStore(path, () => 1200);
		db = new DatabaseSync(path);
		const before = db.prepare("SELECT * FROM life_schedules").all();
		const blocked = store.beginPublicationRun(
			"test-world",
			{ ...input, requestKey: "new-key" },
			"other",
			100,
		);
		expect(blocked.blocked).toBe("pending_run");
		expect(db.prepare("SELECT * FROM life_schedules").all()).toEqual(before);
		expect(store.publicationRun("test-world", run.id)).toEqual(run);
		const resumed = store.beginPublicationRun(
			"test-world",
			input,
			"resumer",
			100,
		);
		expect(resumed.batch).toEqual(run.batch);
		expect(resumed.lease?.owner).toBe("resumer");
		expect(resumed.lease?.token).toBe((run.lease?.token ?? 0) + 1);
	} finally {
		db?.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
test("global pause blocks automatic publication but an explicit manual drain and its stored receipt remain available", () => {
	const store = fixture();
	try {
		const {
			worldId: _w,
			revision: r,
			...config
		} = store.lifeConfig("test-world");
		store.setLifeConfig("test-world", r, {
			...config,
			run: { mode: "paused" },
		});
		const paused = { ...input, expectedConfigRevision: 2 };
		const blocked = store.beginPublicationRun(
			"test-world",
			paused,
			"runner",
			100,
		);
		expect(blocked.status).toBe("blocked");
		expect(blocked.blocked).toBe("paused");
		expect(
			store.beginPublicationRun(
				"test-world",
				{ ...paused, requestKey: "manual", mode: "manual" },
				"runner",
				100,
			).status,
		).toBe("running");
		expect(
			store.beginPublicationRun("test-world", paused, "runner", 100),
		).toEqual(blocked);
	} finally {
		store.close();
	}
});
