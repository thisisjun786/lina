import type { DatabaseSync } from "node:sqlite";
import { parseLifeLease } from "./autonomy-record-validation.ts";
import type { LifeLease } from "./autonomy-types.ts";
import {
	array,
	canonicalLifeJson,
	enumeration,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { parsePublicationJob } from "./publication-record-validation.ts";
import type {
	PublicationRun,
	PublicationRunInput,
} from "./publication-types.ts";
import { fields } from "./validation.ts";

export const PUBLICATION_RUNS_SCHEMA = `
CREATE TABLE life_publication_run_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 run_json TEXT NOT NULL CHECK(json_valid(run_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id,revision)
) STRICT;
CREATE TABLE life_publication_runs (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, request_key TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 run_json TEXT NOT NULL CHECK(json_valid(run_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id), UNIQUE(world_id,request_key),
 FOREIGN KEY(world_id,run_id,revision) REFERENCES life_publication_run_history(world_id,run_id,revision)
) STRICT;
CREATE TABLE life_publication_run_leases (
 world_id TEXT NOT NULL REFERENCES worlds(id), run_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
 lease_json TEXT NOT NULL CHECK(json_valid(lease_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,run_id,sequence),
 FOREIGN KEY(world_id,run_id) REFERENCES life_publication_runs(world_id,run_id)
) STRICT;
`;
export function parsePublicationRunInput(value: unknown): PublicationRunInput {
	jsonBoundary(value);
	fields(value, [
		"requestKey",
		"expectedConfigRevision",
		"expectedSettingsRevision",
		"mode",
	]);
	return {
		requestKey: identifier(value.requestKey),
		expectedConfigRevision: revision(value.expectedConfigRevision),
		expectedSettingsRevision: revision(value.expectedSettingsRevision),
		mode: enumeration(value.mode, ["manual", "automatic"]),
	};
}
function parseRun(value: unknown): PublicationRun {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"revision",
		"input",
		"batch",
		"nextIndex",
		"outcomes",
		"status",
		"blocked",
		"lease",
		"leaseRevision",
	]);
	if (value.version !== 1) throw Error("Unsupported publication run version");
	const run: PublicationRun = {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		input: parsePublicationRunInput(value.input),
		batch: keyed(
			array(value.batch, (v) => {
				fields(v, ["jobId", "attemptId"]);
				return {
					jobId: identifier(v.jobId),
					attemptId: identifier(v.attemptId),
				};
			}),
			(v) => v.jobId,
			false,
		),
		nextIndex: revision(value.nextIndex),
		outcomes: array(value.outcomes, (v) =>
			enumeration(v, ["published", "skipped", "withheld", "failed"]),
		),
		status: enumeration(value.status, ["running", "completed", "blocked"]),
		blocked: nullableId(value.blocked),
		lease: value.lease === null ? null : parseLifeLease(value.lease),
		leaseRevision: revision(value.leaseRevision),
	};
	if (
		run.id !==
			`pubrun-${lifeDigest({ worldId: run.worldId, requestKey: run.input.requestKey })}` ||
		run.nextIndex !== run.outcomes.length ||
		run.nextIndex > run.batch.length ||
		(run.lease === null) !== (run.leaseRevision === 0) ||
		(run.lease && run.lease.worldId !== run.worldId)
	)
		throw Error("Corrupt publication run identity or progress");
	if (
		run.status === "blocked"
			? !run.blocked || run.batch.length || run.lease !== null
			: run.blocked !== null ||
				(run.status === "completed") !== (run.nextIndex === run.batch.length)
	)
		throw Error("Invalid publication run state");
	if (run.status === "running" && !run.lease)
		throw Error("Missing running publication lease");
	return run;
}
type Row = {
	world_id: string;
	run_id: string;
	revision: number;
	run_json: string;
	digest: string;
	request_key?: string;
};
function decode(row: Row): PublicationRun {
	const run = parseRun(JSON.parse(row.run_json));
	if (
		run.worldId !== row.world_id ||
		run.id !== row.run_id ||
		run.revision !== row.revision ||
		lifeDigest(run) !== row.digest ||
		(row.request_key !== undefined && row.request_key !== run.input.requestKey)
	)
		throw Error("Corrupt publication run row");
	return run;
}
function continuity(
	prior: PublicationRun | undefined,
	next: PublicationRun,
): void {
	if (!prior) {
		if (
			next.revision !== 1 ||
			next.nextIndex !== 0 ||
			next.leaseRevision !== (next.lease ? 1 : 0)
		)
			throw Error("Missing initial publication run");
		return;
	}
	if (
		prior.status !== "running" ||
		next.revision !== prior.revision + 1 ||
		next.id !== prior.id ||
		lifeDigest(next.batch) !== lifeDigest(prior.batch) ||
		lifeDigest(next.input) !== lifeDigest(prior.input) ||
		next.status === "blocked"
	)
		throw Error("Publication frozen run changed");
	const progressed =
		next.nextIndex === prior.nextIndex + 1 &&
		lifeDigest(next.outcomes.slice(0, -1)) === lifeDigest(prior.outcomes) &&
		next.leaseRevision === prior.leaseRevision &&
		lifeDigest(next.lease) === lifeDigest(prior.lease);
	const leased =
		next.nextIndex === prior.nextIndex &&
		lifeDigest(next.outcomes) === lifeDigest(prior.outcomes) &&
		next.leaseRevision === prior.leaseRevision + 1 &&
		next.lease &&
		prior.lease &&
		next.lease.generation >= prior.lease.generation &&
		(next.lease.token > prior.lease.token ||
			(next.lease.generation === prior.lease.generation &&
				next.lease.token === prior.lease.token &&
				next.lease.owner === prior.lease.owner));
	if (!progressed && !leased)
		throw Error("Invalid publication run progress history");
}

/** Also consumed by the existing scheduler so publication-only leases fence future simulation. */
export function publicationLeaseHistory(
	db: DatabaseSync,
	worldId: string,
): LifeLease[] {
	if (
		!db
			.prepare(
				"SELECT 1 FROM sqlite_schema WHERE type='table' AND name='life_publication_run_leases'",
			)
			.get()
	)
		return [];
	return db
		.prepare(
			"SELECT * FROM life_publication_run_leases WHERE world_id=? ORDER BY run_id,sequence",
		)
		.all(identifier(worldId))
		.map((row) => {
			identifier(row["run_id"]);
			revision(row["sequence"], 1);
			const lease = parseLifeLease(JSON.parse(String(row["lease_json"])));
			if (lease.worldId !== worldId || lifeDigest(lease) !== row["digest"])
				throw Error("Corrupt publication lease history");
			return lease;
		});
}
/** Caller owns the transaction, including lease admission and job outcome changes. */
export class PublicationRuns {
	constructor(private readonly db: DatabaseSync) {}
	find(worldId: string, requestKey: string): PublicationRun | null {
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_runs WHERE world_id=? AND request_key=?",
			)
			.get(identifier(worldId), identifier(requestKey)) as Row | undefined;
		return row ? this.get(worldId, row.run_id) : null;
	}
	get(worldId: string, runId: string): PublicationRun {
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_runs WHERE world_id=? AND run_id=?",
			)
			.get(identifier(worldId), identifier(runId)) as Row | undefined;
		if (!row) throw Error("Unknown publication run");
		const run = decode(row);
		let prior: PublicationRun | undefined;
		const leases: LifeLease[] = [];
		for (const h of this.db
			.prepare(
				"SELECT * FROM life_publication_run_history WHERE world_id=? AND run_id=? ORDER BY revision",
			)
			.all(worldId, runId)) {
			const next = decode(h as Row);
			continuity(prior, next);
			if (next.lease && next.leaseRevision !== (prior?.leaseRevision ?? 0))
				leases.push(next.lease);
			prior = next;
		}
		if (!prior || lifeDigest(run) !== lifeDigest(prior))
			throw Error("Missing or regressed publication run head");
		const savedLeases = this.db
			.prepare(
				"SELECT * FROM life_publication_run_leases WHERE world_id=? AND run_id=? ORDER BY sequence",
			)
			.all(worldId, runId);
		if (
			savedLeases.length !== leases.length ||
			savedLeases.some(
				(entry, i) =>
					entry["sequence"] !== i + 1 ||
					entry["digest"] !== lifeDigest(leases[i]) ||
					lifeDigest(
						parseLifeLease(JSON.parse(String(entry["lease_json"]))),
					) !== entry["digest"],
			)
		)
			throw Error("Missing or corrupt publication run lease history");
		for (const [index, item] of run.batch.entries()) {
			const history = this.db
				.prepare(
					"SELECT job_json,digest FROM life_publication_job_history WHERE world_id=? AND job_id=? ORDER BY revision",
				)
				.all(worldId, item.jobId);
			const versions = history.map((h) => {
				const job = parsePublicationJob(JSON.parse(String(h["job_json"])));
				if (lifeDigest(job) !== h["digest"])
					throw Error("Corrupt publication job history");
				return job;
			});
			const attempt = versions.filter((j) => j.attemptId === item.attemptId);
			if (
				index >= run.nextIndex &&
				versions.at(-1)?.attemptId !== item.attemptId
			)
				throw Error("Unadvanced publication run attempt changed");
			if (
				!attempt.length ||
				(index < run.nextIndex &&
					!attempt.some((j) => j.status === run.outcomes[index]))
			)
				throw Error("Missing publication run job or outcome");
		}
		return run;
	}
	private save(value: PublicationRun): PublicationRun {
		const run = parseRun(value),
			old = this.db
				.prepare(
					"SELECT * FROM life_publication_runs WHERE world_id=? AND run_id=?",
				)
				.get(run.worldId, run.id) as Row | undefined;
		const prior = old ? this.get(run.worldId, run.id) : undefined;
		continuity(prior, run);
		const json = canonicalLifeJson(run),
			digest = lifeDigest(run);
		this.db
			.prepare(
				"INSERT INTO life_publication_run_history(world_id,run_id,revision,run_json,digest) VALUES(?,?,?,?,?)",
			)
			.run(run.worldId, run.id, run.revision, json, digest);
		this.db
			.prepare(
				"INSERT INTO life_publication_runs(world_id,run_id,request_key,revision,run_json,digest) VALUES(?,?,?,?,?,?) ON CONFLICT(world_id,run_id) DO UPDATE SET revision=excluded.revision,run_json=excluded.run_json,digest=excluded.digest",
			)
			.run(
				run.worldId,
				run.id,
				run.input.requestKey,
				run.revision,
				json,
				digest,
			);
		if (run.lease && run.leaseRevision !== (prior?.leaseRevision ?? 0))
			this.db
				.prepare(
					"INSERT INTO life_publication_run_leases(world_id,run_id,sequence,lease_json,digest) VALUES(?,?,?,?,?)",
				)
				.run(
					run.worldId,
					run.id,
					run.leaseRevision,
					canonicalLifeJson(run.lease),
					lifeDigest(run.lease),
				);
		return this.get(run.worldId, run.id);
	}
	begin(
		worldId: string,
		value: PublicationRunInput,
		batch: PublicationRun["batch"],
		lease: LifeLease | null,
		blocked: string | null,
	): PublicationRun {
		identifier(worldId);
		const input = parsePublicationRunInput(value),
			prior = this.find(worldId, input.requestKey);
		if (prior) {
			if (lifeDigest(prior.input) !== lifeDigest(input))
				throw Error("Publication run request conflict");
			return prior;
		}
		return this.save({
			version: 1,
			worldId,
			id: `pubrun-${lifeDigest({ worldId, requestKey: input.requestKey })}`,
			revision: 1,
			input,
			batch,
			lease,
			leaseRevision: lease ? 1 : 0,
			nextIndex: 0,
			outcomes: [],
			status: blocked ? "blocked" : batch.length ? "running" : "completed",
			blocked,
		});
	}
	attachLease(
		worldId: string,
		runId: string,
		lease: LifeLease,
	): PublicationRun {
		const run = this.get(worldId, runId);
		if (lifeDigest(run.lease) === lifeDigest(lease)) return run;
		return this.save({
			...run,
			revision: revision(run.revision + 1, 1),
			lease: parseLifeLease(lease),
			leaseRevision: revision(run.leaseRevision + 1, 1),
		});
	}
	advance(
		worldId: string,
		runId: string,
		jobId: string,
		attemptId: string,
		outcome: PublicationRun["outcomes"][number],
	): PublicationRun {
		const run = this.get(worldId, runId),
			index = run.batch.findIndex(
				(j) => j.jobId === jobId && j.attemptId === attemptId,
			);
		if (
			index < 0 ||
			index > run.nextIndex ||
			(index < run.nextIndex && run.outcomes[index] !== outcome)
		)
			throw Error("Publication run progress conflict");
		if (index < run.nextIndex) return run;
		const nextIndex = revision(run.nextIndex + 1, 1);
		return this.save({
			...run,
			revision: revision(run.revision + 1, 1),
			nextIndex,
			outcomes: [...run.outcomes, outcome],
			status: nextIndex === run.batch.length ? "completed" : "running",
		});
	}
	list(worldId: string): PublicationRun[] {
		return this.db
			.prepare(
				"SELECT run_id FROM life_publication_runs WHERE world_id=? ORDER BY rowid",
			)
			.all(identifier(worldId))
			.map((row) => this.get(worldId, String(row["run_id"])));
	}
	pending(worldId: string): PublicationRun[] {
		return this.db
			.prepare(
				"SELECT run_id FROM life_publication_runs WHERE world_id=? ORDER BY rowid",
			)
			.all(identifier(worldId))
			.map((r) => this.get(worldId, String(r["run_id"])))
			.filter((r) => r.status === "running");
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id,run_id FROM life_publication_runs UNION SELECT world_id,run_id FROM life_publication_run_history UNION SELECT world_id,run_id FROM life_publication_run_leases",
			)
			.all())
			this.get(String(row["world_id"]), String(row["run_id"]));
	}
}
