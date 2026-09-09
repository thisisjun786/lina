import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import {
	PUBLICATION_JOBS_SCHEMA,
	PublicationJobs,
} from "../src/world/publication-jobs.ts";
import { publicationModelId } from "../src/world/publication-model.ts";
import {
	parsePublicationJob,
	parsePublicationMaterial,
} from "../src/world/publication-record-validation.ts";
import type { PublicationMaterial } from "../src/world/publication-types.ts";
import records from "./fixtures/life-publication-reply-records.json";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "lina-reply-jobs-"));
	const path = join(root, "world.sqlite");
	let db = new DatabaseSync(path);
	db.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world'),('other-world')",
	);
	db.exec(PUBLICATION_JOBS_SCHEMA);
	return {
		get jobs() {
			return new PublicationJobs(db);
		},
		discover() {
			return this.jobs.discoverReply(
				"world",
				records.event.post.id,
				"b",
				"friends",
			);
		},
		freeze() {
			const job = this.discover();
			return this.jobs.freeze(
				"world",
				job.id,
				parsePublicationMaterial(records.reply.material),
				records.reply.job.author,
				1,
			);
		},
		rows() {
			return [
				db
					.prepare(
						"SELECT * FROM life_publication_jobs ORDER BY world_id,job_id",
					)
					.all(),
				db
					.prepare(
						"SELECT * FROM life_publication_job_history ORDER BY world_id,job_id,revision",
					)
					.all(),
				db
					.prepare(
						"SELECT * FROM life_publication_job_requests ORDER BY world_id,request_key",
					)
					.all(),
			];
		},
		changes() {
			return db.prepare("SELECT total_changes() AS count").get()?.["count"];
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			this.jobs.validate();
		},
		close() {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function reseal(material: PublicationMaterial): PublicationMaterial {
	const { id: _id, digest: _digest, ...body } = material;
	const identified = { ...body, id: `material-${lifeDigest(body)}` };
	return parsePublicationMaterial({
		...identified,
		digest: lifeDigest(identified),
	});
}

test("reply discovery persists one typed parent/author/recipient job across SQLite reopen", () => {
	const f = fixture();
	try {
		const job = f.discover();
		expect(job).toEqual({
			version: 2,
			id: records.reply.job.id,
			worldId: "world",
			revision: 1,
			source: { kind: "reply", parentPostId: records.event.post.id },
			authorAgentId: "b",
			recipientId: "friends",
			attempt: 1,
			attemptId: records.reply.job.attemptId,
			status: "pending",
			material: null,
			author: null,
			modelSettingsRevision: null,
			decision: null,
			postId: null,
			error: null,
		});
		const before = f.rows();
		f.reopen();
		expect(f.discover()).toEqual(job);
		expect(f.jobs.list("world")).toEqual([job]);
		expect(f.jobs.history("world", job.id)).toEqual([job]);
		expect(f.rows()).toEqual(before);
		expect(f.changes()).toBe(0);
		const otherIds = [
			f.jobs.discover("world", records.event.post.id, "b", "friends").id,
			f.jobs.discoverReply("world", "another-parent", "b", "friends").id,
			f.jobs.discoverReply("world", records.event.post.id, "c", "friends").id,
			f.jobs.discoverReply("world", records.event.post.id, "b", "public").id,
			f.jobs.discoverReply("other-world", records.event.post.id, "b", "friends")
				.id,
		];
		expect(new Set([job.id, ...otherIds]).size).toBe(6);
		f.reopen();
		expect(f.jobs.list("world")).toHaveLength(5);
	} finally {
		f.close();
	}
});

test.each(["failed", "withheld"] as const)(
	"reply %s retries preserve the logical parent and deduplicate a lost retry response",
	(status) => {
		const f = fixture();
		try {
			const prepared = f.freeze();
			const failed = f.jobs.withhold(
				"world",
				prepared.id,
				"unavailable",
				status === "failed",
			);
			const input = {
				requestKey: "retry-once",
				expectedRevision: failed.revision,
			};
			const retry = f.jobs.retry("world", prepared.id, input);
			expect(retry).toMatchObject({
				version: 2,
				id: prepared.id,
				source: { kind: "reply", parentPostId: records.event.post.id },
				attempt: 2,
				status: "pending",
				material: null,
				author: null,
				modelSettingsRevision: null,
				decision: null,
				postId: null,
				error: null,
			});
			expect(retry.attemptId).not.toBe(prepared.attemptId);
			expect(publicationModelId(retry.attemptId)).not.toBe(
				publicationModelId(prepared.attemptId),
			);
			const before = f.rows();
			f.reopen();
			expect(f.discover()).toEqual(retry);
			expect(f.jobs.retry("world", prepared.id, input)).toEqual(retry);
			expect(() =>
				f.jobs.retry("world", prepared.id, {
					...input,
					expectedRevision: retry.revision,
				}),
			).toThrow("conflict");
			expect(f.rows()).toEqual(before);
			expect(f.changes()).toBe(0);
			expect(f.freeze()).toMatchObject({
				version: 2,
				attempt: 2,
				status: "prepared",
			});
			f.reopen();
		} finally {
			f.close();
		}
	},
);

test("unknown reply retains its attempt; reconciled no_reply stays skipped through rediscovery and restart", () => {
	const f = fixture();
	try {
		const prepared = f.freeze();
		const unknown = f.jobs.unknown("world", prepared.id);
		f.reopen();
		expect(f.discover()).toEqual(unknown);
		expect(f.jobs.unknown("world", prepared.id)).toEqual(unknown);
		expect(() =>
			f.jobs.retry("world", prepared.id, {
				requestKey: "reroll",
				expectedRevision: unknown.revision,
			}),
		).toThrow("eligible outcome");
		const ready = f.jobs.ready("world", prepared.id, { kind: "no_reply" });
		expect(ready.attemptId).toBe(prepared.attemptId);
		expect(f.jobs.ready("world", prepared.id, { kind: "no_reply" })).toEqual(
			ready,
		);
		const skipped = f.jobs.complete("world", prepared.id, null);
		expect(skipped).toMatchObject({
			status: "skipped",
			decision: { kind: "no_reply" },
			postId: null,
		});
		const before = f.rows();
		f.reopen();
		expect(f.discover()).toEqual(skipped);
		expect(f.jobs.complete("world", prepared.id, null)).toEqual(skipped);
		expect(() =>
			f.jobs.retry("world", prepared.id, {
				requestKey: "retry-skipped",
				expectedRevision: skipped.revision,
			}),
		).toThrow("eligible outcome");
		expect(f.rows()).toEqual(before);
		expect(f.changes()).toBe(0);
	} finally {
		f.close();
	}
});

test("reply decisions use supported post segments and reject event-only or counterfeit output without SQL writes", () => {
	const f = fixture();
	try {
		const prepared = f.freeze();
		const before = f.rows(),
			changes = f.changes();
		for (const decision of [
			{ kind: "no_post" as const },
			{
				kind: "post" as const,
				segments: [{ kind: "claim" as const, claimId: "unposted-claim" }],
			},
			{ kind: "post" as const, segments: [] },
		])
			expect(() => f.jobs.ready("world", prepared.id, decision)).toThrow();
		expect(f.rows()).toEqual(before);
		expect(f.changes()).toBe(changes);
		const golden = parsePublicationJob(records.reply.job);
		if (!golden.decision) throw Error("Missing golden decision");
		expect(f.jobs.ready("world", prepared.id, golden.decision)).toEqual(golden);
		const published = f.jobs.complete(
			"world",
			prepared.id,
			records.reply.post.id,
		);
		f.reopen();
		expect(f.discover()).toEqual(published);
		expect(
			f.jobs.complete("world", prepared.id, records.reply.post.id),
		).toEqual(published);
		expect(() =>
			f.jobs.retry("world", prepared.id, {
				requestKey: "retry-published",
				expectedRevision: published.revision,
			}),
		).toThrow();
	} finally {
		f.close();
	}
});

test.each(["pending", "prepared"] as const)(
	"%s jobs reject both material version mismatches before writing",
	(status) => {
		const f = fixture();
		try {
			const reply = status === "prepared" ? f.freeze() : f.discover();
			let event = f.jobs.discover("world", "intent", "a", "friends");
			if (status === "prepared")
				event = f.jobs.freeze(
					"world",
					event.id,
					parsePublicationMaterial(records.event.material),
					records.event.job.author,
					1,
				);
			const before = f.rows(),
				changes = f.changes();
			expect(() =>
				f.jobs.freeze(
					"world",
					reply.id,
					parsePublicationMaterial(records.event.material),
					records.reply.job.author,
					1,
				),
			).toThrow("version mismatch");
			expect(() =>
				f.jobs.freeze(
					"world",
					event.id,
					parsePublicationMaterial(records.reply.material),
					records.event.job.author,
					1,
				),
			).toThrow("version mismatch");
			expect(f.rows()).toEqual(before);
			expect(f.changes()).toBe(changes);
			f.reopen();
			expect(f.rows()).toEqual(before);
		} finally {
			f.close();
		}
	},
);

test("a frozen reply cannot change its parent revision, public author or model settings", () => {
	const f = fixture();
	try {
		const prepared = f.freeze();
		if (prepared.version !== 2 || !prepared.material || !prepared.author)
			throw Error("Missing reply source");
		const { material, author } = prepared;
		const changedParent = reseal({
			...prepared.material,
			source: { ...prepared.material.source, parentPostRevision: 2 },
			parent: { ...prepared.material.parent, revision: 2 },
			authority: {
				...prepared.material.authority,
				posts: [{ kind: "post", id: records.event.post.id, revision: 2 }],
			},
		});
		const before = f.rows(),
			changes = f.changes();
		expect(f.freeze()).toEqual(prepared);
		expect(() =>
			f.jobs.freeze("world", prepared.id, changedParent, author, 1),
		).toThrow("preparation conflict");
		expect(() =>
			f.jobs.freeze(
				"world",
				prepared.id,
				material,
				{ ...author, voice: "Changed" },
				1,
			),
		).toThrow("preparation conflict");
		expect(() =>
			f.jobs.freeze("world", prepared.id, material, author, 2),
		).toThrow("preparation conflict");
		expect(f.rows()).toEqual(before);
		expect(f.changes()).toBe(changes);
		f.reopen();
		expect(f.discover()).toEqual(prepared);
	} finally {
		f.close();
	}
});

test("event v1 ready bytes match the independent golden fixture and no_post remains terminal after reopen", () => {
	const f = fixture();
	try {
		const job = f.jobs.discover("world", "intent", "a", "friends");
		const material = parsePublicationMaterial(records.event.material);
		f.jobs.freeze("world", job.id, material, records.event.job.author, 1);
		const golden = parsePublicationJob(records.event.job);
		if (!golden.decision) throw Error("Missing golden decision");
		const ready = f.jobs.ready("world", job.id, golden.decision);
		expect(lifeDigest(ready)).toBe(records.golden.eventJob);
		expect(canonicalLifeJson(ready)).toBe(canonicalLifeJson(records.event.job));
		const before = f.rows();
		f.reopen();
		expect(f.jobs.get("world", job.id)).toEqual(golden);
		expect(f.rows()).toEqual(before);
		// A separate legacy job proves the decline path without rewriting ready history.
		const declined = f.jobs.discover("world", "another-intent", "a", "friends");
		if (material.version !== 1) throw Error("Missing event source");
		const otherMaterial = reseal({
			...material,
			source: { ...material.source, intentId: "another-intent" },
		});
		f.jobs.freeze(
			"world",
			declined.id,
			otherMaterial,
			records.event.job.author,
			1,
		);
		expect(() =>
			f.jobs.ready("world", declined.id, { kind: "no_reply" }),
		).toThrow();
		f.jobs.ready("world", declined.id, { kind: "no_post" });
		const skipped = f.jobs.complete("world", declined.id, null);
		f.reopen();
		expect(f.jobs.discover("world", "another-intent", "a", "friends")).toEqual(
			skipped,
		);
		expect(skipped.decision).toEqual({ kind: "no_post" });
	} finally {
		f.close();
	}
});
