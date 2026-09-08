import type { DatabaseSync } from "node:sqlite";
import { canonical, counter, decode, hash } from "./codec.ts";
import { derivationSchema, jobSchema, type ResourceJob } from "./job-codec.ts";
import { resultSchema } from "./records.ts";

export function jobKey(
	job: Pick<ResourceJob, "resourceId" | "sourceDigest" | "kind" | "generation">,
): string {
	return hash([job.resourceId, job.sourceDigest, job.kind, job.generation]);
}
export function readJob(db: DatabaseSync, id: string): ResourceJob | undefined {
	const row = db.prepare("SELECT * FROM resource_jobs WHERE id=?").get(id);
	if (!row) return;
	const job = decode(jobSchema, row["data"]);
	if (
		job.id !== row["id"] ||
		job.id !== jobKey(job) ||
		job.resourceId !== row["resource_id"] ||
		job.sourceDigest !== row["source_digest"] ||
		hash(job.refs) !== job.sourceDigest ||
		job.kind !== row["kind"] ||
		hash(job.generation) !== row["generation_key"] ||
		job.generation.policyRevision !== row["policy_revision"] ||
		job.generation.modelSettingsRevision !== row["model_settings_revision"]
	)
		throw Error("corrupt resource job projection");
	return job;
}
export function writeJob(db: DatabaseSync, raw: ResourceJob): void {
	const job = jobSchema.parse(raw);
	db.prepare(
		"INSERT INTO resource_jobs VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
	).run(
		job.id,
		job.resourceId,
		job.sourceDigest,
		job.generation.policyRevision,
		job.generation.modelSettingsRevision,
		job.kind,
		hash(job.generation),
		canonical(job),
	);
}
export function attempts(db: DatabaseSync, job: ResourceJob): number {
	return counter
		.max(3)
		.parse(
			db
				.prepare(
					"SELECT attempts FROM resource_job_attempts WHERE resource_id=? AND source_digest=? AND kind=?",
				)
				.get(job.resourceId, job.sourceDigest, job.kind)?.["attempts"] ?? 0,
		);
}
export function auditJobs(db: DatabaseSync): void {
	const groups = new Map<string, Set<number>>();
	const expectedFts: string[] = [];
	for (const row of db.prepare("SELECT id FROM resource_jobs").all()) {
		const job = readJob(db, String(row["id"]));
		if (!job) throw Error("corrupt resource job");
		if (!job.refs.some((ref) => ref.resourceId === job.resourceId))
			throw Error("corrupt resource job root");
		for (const ref of job.refs) {
			const row = db
				.prepare(
					"SELECT result FROM resource_operations WHERE resource_id=? AND revision=?",
				)
				.get(ref.resourceId, ref.resourceRevision);
			if (!row) throw Error("corrupt resource job source");
			const source = decode(resultSchema, row["result"]).resource;
			if (
				source.currentVersion !== ref.versionId ||
				source.deleted ||
				(source.id === job.resourceId &&
					(source.ownerId !== job.ownerId ||
						source.visibility !== job.visibility))
			)
				throw Error("corrupt resource job source state");
		}
		const key = canonical([job.resourceId, job.sourceDigest, job.kind]);
		const used = groups.get(key) ?? new Set<number>();
		if (job.attempt > 0) used.add(job.attempt);
		groups.set(key, used);
		if (job.attempt > attempts(db, job))
			throw Error("corrupt resource attempt receipt");
		const derived = db
			.prepare(
				"SELECT data FROM resource_derivations WHERE resource_id=? AND source_digest=? AND policy_revision=? AND model_settings_revision=? AND kind=? AND generation_key=?",
			)
			.get(
				job.resourceId,
				job.sourceDigest,
				job.generation.policyRevision,
				job.generation.modelSettingsRevision,
				job.kind,
				hash(job.generation),
			);
		if ((job.state === "ready") !== Boolean(derived))
			throw Error("corrupt resource derivation state");
		if (derived) {
			const output = decode(derivationSchema, derived["data"]);
			if (output.jobId !== job.id || hash(output) !== job.outputHash)
				throw Error("corrupt resource derivation receipt");
			expectedFts.push(
				canonical([job.resourceId, job.sourceDigest, output.text]),
			);
		}
	}
	for (const row of db.prepare("SELECT * FROM resource_job_attempts").all()) {
		const n = counter.max(3).parse(row["attempts"]),
			key = canonical([row["resource_id"], row["source_digest"], row["kind"]]);
		if (!groups.has(key) || n < 1 || Math.max(...(groups.get(key) ?? [])) !== n)
			throw Error("corrupt resource attempts");
	}
	for (const row of db.prepare("SELECT * FROM resource_derivations").all()) {
		const d = decode(derivationSchema, row["data"]),
			job = readJob(db, d.jobId);
		if (
			!job ||
			job.state !== "ready" ||
			job.resourceId !== row["resource_id"] ||
			job.sourceDigest !== row["source_digest"] ||
			job.generation.policyRevision !== row["policy_revision"] ||
			job.generation.modelSettingsRevision !== row["model_settings_revision"] ||
			job.kind !== row["kind"] ||
			hash(job.generation) !== row["generation_key"]
		)
			throw Error("corrupt orphan derivation");
	}
	const actualFts = db
		.prepare("SELECT resource_id,source_digest,text FROM resource_fts")
		.all()
		.map((row) =>
			canonical([row["resource_id"], row["source_digest"], row["text"]]),
		);
	if (canonical(actualFts.sort()) !== canonical(expectedFts.sort()))
		throw Error("corrupt resource search projection");
}
