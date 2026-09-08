import { expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { acquireSessionLease } from "../../lina-core/src/session-binding.ts";
import { ordinarySource } from "../../lina-memory/test/fixtures/native-sources.ts";
import { CompanionQueue } from "../src/context/companion-queue.ts";
import { createRuntimeFixture } from "./runtime-fixture.ts";

function queue(
	path: string,
	binding: ConstructorParameters<typeof CompanionQueue>[1],
	options: ConstructorParameters<typeof CompanionQueue>[2] = {},
) {
	return new CompanionQueue(path, binding, {
		...options,
		lookup: (id) => ordinarySource({ entryId: id, role: "user", text: id }),
	});
}
test("episode lookup outage preserves pending and failed jobs with attempts and history across reopen", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "lookup-outage.sqlite");
	let unavailable = false;
	const options = {
		now: () => 1000,
		validateEpisode: () => {
			if (unavailable) throw Error("episode lookup unavailable");
		},
	};
	let q = queue(path, f.runtime.binding, options);
	const db = new DatabaseSync(path);
	const snapshot = () => ({
		jobs: db.prepare("SELECT * FROM companion_jobs ORDER BY id").all(),
		history: db.prepare("SELECT * FROM companion_history ORDER BY seq").all(),
	});
	try {
		q.add("pending", ["pending"], 1);
		q.add("failed", ["failed"], 2);
		q.start("failed");
		q.finish("failed", false, "observer_failed");
		const before = snapshot();
		unavailable = true;
		expect(() => q.pending()).toThrow("episode lookup unavailable");
		expect(snapshot()).toEqual(before);
		q.close();
		q = queue(path, f.runtime.binding, options);
		expect(() => q.pending()).toThrow("episode lookup unavailable");
		expect(snapshot()).toEqual(before);
		unavailable = false;
		expect(q.pending().map((job) => job.id)).toEqual(["pending"]);
		expect(q.counts().failed).toBe(1);
		q.start("pending");
		q.finish("pending", true);
		expect(q.counts().accepted).toBe(1);
	} finally {
		q.close();
		db.close();
		await f.close();
	}
});
test("derived work survives restart and coalesces replay without merging another room", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "queue.sqlite");
	let q = queue(path, f.runtime.binding);
	try {
		q.add("u1", ["u1", "a1"], 2);
		q.add("u1", ["u1", "a1"], 2);
		expect(q.pending()).toHaveLength(1);
		q.start("u1");
		q.close();
		q = queue(path, f.runtime.binding);
		expect(q.pending()[0]?.id).toBe("u1");
		expect(q.cursor()).toBe(2);
		q.finish("u1", true);
		expect(q.pending()).toHaveLength(0);
		expect(() =>
			queue(path, { ...f.runtime.binding, botId: "other" }),
		).toThrow();
	} finally {
		q.close();
		await f.close();
	}
});

// RED: failed work was immediately eligible on every refresh.
test("retry deadlines and attempt cap survive reopening without sleeps", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "queue.sqlite");
	let now = 1000;
	let q = queue(path, f.runtime.binding, { now: () => now });
	try {
		q.add("u", ["u"], 1);
		expect(q.start("u")).toBe(true);
		expect(q.start("u")).toBe(false);
		q.finish("u", false, "observer_failed");
		expect(q.pending()).toEqual([]);
		q.close();
		q = queue(path, f.runtime.binding, { now: () => now });
		expect(q.pending()).toEqual([]);
		now = 2000;
		expect(q.pending()).toHaveLength(1);
		q.start("u");
		q.finish("u", false, "observer_failed");
		now = 3999;
		expect(q.pending()).toEqual([]);
		now = 4000;
		expect(q.pending()).toHaveLength(1);
		q.start("u");
		q.finish("u", false, "observer_failed");
		now = 100000;
		expect(q.pending()).toEqual([]);
		expect(q.counts().failed).toBe(1);
	} finally {
		q.close();
		await f.close();
	}
});

test("a second in-process queue owner cannot recover active work", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "queue.sqlite");
	const q = queue(path, f.runtime.binding);
	let second: CompanionQueue | undefined;
	try {
		q.add("u", ["u"], 1);
		q.start("u");
		expect(() => {
			second = queue(path, f.runtime.binding);
		}).toThrow();
		expect(q.counts().sending).toBe(1);
	} finally {
		second?.close();
		q.close();
		await f.close();
	}
});

test("conflicting replay cannot advance the cursor or replace source evidence", async () => {
	const f = createRuntimeFixture();
	const q = queue(join(f.root, "queue.sqlite"), f.runtime.binding);
	try {
		q.add("u", ["u", "a"], 2);
		expect(() => q.add("u", ["u", "other"], 10)).toThrow();
		expect(q.cursor()).toBe(2);
		expect(q.pending()[0]?.sources).toEqual(["u", "a"]);
	} finally {
		q.close();
		await f.close();
	}
});

test("legacy queue schema is rejected without changing its sources or cursor", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "legacy.sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec(
			"CREATE TABLE companion_meta (id INTEGER PRIMARY KEY CHECK(id=1), binding TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor>=0)) STRICT; CREATE TABLE companion_jobs (id TEXT PRIMARY KEY, sources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')), attempts INTEGER NOT NULL CHECK(attempts>=0)) STRICT; PRAGMA user_version=1;",
		);
		db.prepare("INSERT INTO companion_meta VALUES (1,?,7)").run(
			JSON.stringify(f.runtime.binding),
		);
		db.prepare("INSERT INTO companion_jobs VALUES (?,?,'running',1)").run(
			"old",
			'["u"]',
		);
		expect(() => queue(path, f.runtime.binding)).toThrow(
			"legacy jobs require explicit migration",
		);
		expect(db.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(1);
		expect(
			db.prepare("SELECT cursor FROM companion_meta").get()?.["cursor"],
		).toBe(7);
		expect(
			db.prepare("SELECT sources,state FROM companion_jobs").get(),
		).toEqual({ sources: '["u"]', state: "running" });
	} finally {
		db.close();
		await f.close();
	}
});

test("existing session lease excludes another app until its queue is closed", async () => {
	const f = createRuntimeFixture();
	const stateRoot = join(f.root, "state");
	const owner = acquireSessionLease(stateRoot, f.runtime.binding.botId, f.root);
	const q = queue(join(owner.root, "queue.sqlite"), f.runtime.binding);
	try {
		q.add("u", ["u"], 1);
		q.start("u");
		expect(() =>
			acquireSessionLease(stateRoot, f.runtime.binding.botId, f.root),
		).toThrow();
		expect(q.counts().sending).toBe(1);
	} finally {
		q.close();
		owner.close();
	}
	const successor = acquireSessionLease(
		stateRoot,
		f.runtime.binding.botId,
		f.root,
	);
	const recovered = queue(
		join(successor.root, "queue.sqlite"),
		f.runtime.binding,
	);
	try {
		expect(recovered.pending()).toMatchObject([{ id: "u", sources: ["u"] }]);
	} finally {
		recovered.close();
		successor.close();
		await f.close();
	}
});

test("explicit recovery preserves old attempts and errors and grants only bounded new attempts", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "recovery.sqlite");
	let now = 1000;
	let q = queue(path, f.runtime.binding, { now: () => now });
	try {
		q.add("u", ["u"], 1);
		for (let i = 0; i < 3; i++) {
			expect(q.start("u")).toBe(true);
			q.finish("u", false, "provider_quota");
			now += 30000;
		}
		expect(q.pending()).toEqual([]);
		expect(q.recover(["u"], "direct-provider-verified")).toBe(1);
		expect(q.recover(["u"], "direct-provider-verified")).toBe(0);
		expect(q.start("u")).toBe(true);
		q.finish("u", true, null, "unchanged");
		q.close();
		q = queue(path, f.runtime.binding, { now: () => now });
		expect(q.processing()).toMatchObject({
			unchanged: 1,
			changed: 0,
			retrying: 0,
			failed: 0,
		});
		const db = new DatabaseSync(path);
		try {
			expect(
				db.prepare("SELECT attempts FROM companion_jobs WHERE id='u'").get()?.[
					"attempts"
				],
			).toBe(4);
			expect(
				Number(
					db
						.prepare(
							"SELECT count(*) n FROM companion_history WHERE error='provider_quota'",
						)
						.get()?.["n"],
				),
			).toBe(3);
		} finally {
			db.close();
		}
	} finally {
		q.close();
		await f.close();
	}
});

test("exact v2 migration preserves failed sources, cursor and consumed attempts", async () => {
	const f = createRuntimeFixture();
	const path = join(f.root, "v2.sqlite");
	let q = queue(path, f.runtime.binding);
	try {
		q.add("u", ["u", "a"], 7);
		q.start("u");
		q.finish("u", false, "legacy_provider_failure");
		q.close();
		const db = new DatabaseSync(path);
		db.exec(
			`DROP TABLE companion_history; DROP TABLE companion_job_meta; DROP INDEX companion_ready;
ALTER TABLE companion_jobs RENAME TO old_jobs;
CREATE TABLE companion_jobs (id TEXT PRIMARY KEY, sources TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','done','failed')), attempts INTEGER NOT NULL CHECK(attempts>=0), retry_at INTEGER NOT NULL CHECK(retry_at>=0), error TEXT) STRICT;
INSERT INTO companion_jobs SELECT id,sources,state,attempts,retry_at,error FROM old_jobs;
DROP TABLE old_jobs;
CREATE INDEX companion_ready ON companion_jobs(state,retry_at);
PRAGMA user_version=2`,
		);
		db.close();
		q = queue(path, f.runtime.binding);
		expect(q.cursor()).toBe(7);
		expect(q.error()).toBe("legacy_provider_failure");
		const check = new DatabaseSync(path);
		try {
			expect(
				check
					.prepare("SELECT sources,attempts FROM companion_jobs WHERE id='u'")
					.get(),
			).toEqual({ sources: '["u","a"]', attempts: 1 });
			expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
				4,
			);
		} finally {
			check.close();
		}
	} finally {
		q.close();
		await f.close();
	}
});

test("the same recovery authorization cannot grant unlimited attempts after failure", async () => {
	const f = createRuntimeFixture();
	let now = 1000;
	const q = queue(join(f.root, "once.sqlite"), f.runtime.binding, {
		now: () => now,
	});
	try {
		q.add("u", ["u"], 1);
		for (let round = 0; round < 2; round++) {
			for (let i = 0; i < 3; i++) {
				q.start("u");
				q.finish("u", false, "offline");
				now += 30000;
			}
			if (round === 0) expect(q.recover(["u"], "fixed-route")).toBe(1);
		}
		expect(q.recover(["u"], "fixed-route")).toBe(0);
	} finally {
		q.close();
		await f.close();
	}
});
