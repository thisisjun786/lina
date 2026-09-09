import type { DatabaseSync } from "node:sqlite";
import {
	canonicalLifeJson,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import {
	type LifeModelSelection,
	parseLifeModelSelection,
} from "./model-selection.ts";
import {
	parsePublicationAuthor,
	parsePublicationJob,
	parsePublicationMaterial,
	publicationAttemptId,
	publicationJobId,
	publicationReplyJobId,
} from "./publication-record-validation.ts";
import type {
	PublicationAuthor,
	PublicationDecision,
	PublicationJob,
	PublicationMaterial,
} from "./publication-types.ts";
import { parsePublicationDecision } from "./publication-validation.ts";
import { fields } from "./validation.ts";

export const PUBLICATION_JOBS_SCHEMA = `
CREATE TABLE life_publication_job_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 job_json TEXT NOT NULL CHECK(json_valid(job_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_jobs (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 job_json TEXT NOT NULL CHECK(json_valid(job_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,job_id),
 FOREIGN KEY(world_id,job_id,revision) REFERENCES life_publication_job_history(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_job_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, job_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>0), result_revision INTEGER NOT NULL CHECK(result_revision>0), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,job_id,result_revision) REFERENCES life_publication_job_history(world_id,job_id,revision)
) STRICT;
CREATE TABLE life_publication_model_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, request_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_id), FOREIGN KEY(world_id,job_id) REFERENCES life_publication_jobs(world_id,job_id)
) STRICT;
`;
type Row = {
	world_id: string;
	job_id: string;
	revision: number;
	job_json: string;
	digest: string;
};
function decode(row: Row): PublicationJob {
	const job = parsePublicationJob(JSON.parse(row.job_json));
	if (
		row.world_id !== job.worldId ||
		row.job_id !== job.id ||
		row.revision !== job.revision ||
		row.digest !== lifeDigest(job)
	)
		throw Error("Corrupt publication job row");
	return job;
}
function continuity(
	prior: PublicationJob | undefined,
	next: PublicationJob,
): void {
	if (!prior) {
		if (next.revision !== 1 || next.attempt !== 1 || next.status !== "pending")
			throw Error("Missing initial publication job");
		return;
	}
	if (next.revision !== prior.revision + 1 || next.id !== prior.id)
		throw Error("Regressed publication job history");
	if (next.attempt !== prior.attempt) {
		if (
			!["failed", "withheld"].includes(prior.status) ||
			next.status !== "pending" ||
			next.attempt !== prior.attempt + 1
		)
			throw Error("Invalid publication retry history");
		return;
	}
	const allowed: Record<PublicationJob["status"], PublicationJob["status"][]> =
		{
			pending: ["prepared", "withheld", "failed"],
			prepared: ["ready", "unknown", "withheld", "failed"],
			unknown: ["ready", "failed"],
			ready: ["published", "skipped", "withheld", "failed"],
			published: [],
			skipped: [],
			withheld: [],
			failed: [],
		};
	if (!allowed[prior.status].includes(next.status))
		throw Error("Invalid publication job transition");
	if (
		prior.material &&
		(lifeDigest(prior.material) !== lifeDigest(next.material) ||
			lifeDigest(prior.modelSelection ?? null) !==
				lifeDigest(next.modelSelection ?? null) ||
			lifeDigest(prior.author) !== lifeDigest(next.author) ||
			prior.modelSettingsRevision !== next.modelSettingsRevision)
	)
		throw Error("Publication frozen source changed");
}
/** SQL owner, called only within the surrounding WorldStore transaction. */
export class PublicationJobs {
	constructor(private readonly db: DatabaseSync) {}
	private row(worldId: string, jobId: string): Row | undefined {
		return this.db
			.prepare(
				"SELECT * FROM life_publication_jobs WHERE world_id=? AND job_id=?",
			)
			.get(identifier(worldId), identifier(jobId)) as Row | undefined;
	}
	get(worldId: string, jobId: string): PublicationJob {
		const row = this.row(worldId, jobId);
		if (!row) throw Error("Unknown publication job");
		const head = decode(row),
			history = this.db
				.prepare(
					"SELECT * FROM life_publication_job_history WHERE world_id=? AND job_id=? ORDER BY revision",
				)
				.all(worldId, jobId) as Row[];
		let prior: PublicationJob | undefined;
		for (const item of history) {
			const next = decode(item);
			continuity(prior, next);
			prior = next;
		}
		if (!prior || lifeDigest(prior) !== lifeDigest(head))
			throw Error("Missing or regressed publication job head");
		return head;
	}
	list(worldId: string): PublicationJob[] {
		return this.db
			.prepare(
				"SELECT job_id FROM life_publication_jobs WHERE world_id=? ORDER BY rowid",
			)
			.all(identifier(worldId))
			.map((r) => this.get(worldId, String(r["job_id"])));
	}
	history(worldId: string, jobId: string): PublicationJob[] {
		this.get(worldId, jobId);
		return (
			this.db
				.prepare(
					"SELECT * FROM life_publication_job_history WHERE world_id=? AND job_id=? ORDER BY revision",
				)
				.all(worldId, jobId) as Row[]
		).map(decode);
	}
	private save(value: PublicationJob): PublicationJob {
		const job = parsePublicationJob(value),
			old = this.row(job.worldId, job.id);
		continuity(old ? this.get(job.worldId, job.id) : undefined, job);
		const json = canonicalLifeJson(job),
			digest = lifeDigest(job);
		this.db
			.prepare(
				"INSERT INTO life_publication_job_history(world_id,job_id,revision,job_json,digest) VALUES(?,?,?,?,?)",
			)
			.run(job.worldId, job.id, job.revision, json, digest);
		this.db
			.prepare(
				"INSERT INTO life_publication_jobs(world_id,job_id,revision,job_json,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,job_id) DO UPDATE SET revision=excluded.revision,job_json=excluded.job_json,digest=excluded.digest",
			)
			.run(job.worldId, job.id, job.revision, json, digest);
		return job;
	}
	discover(
		worldId: string,
		intentId: string,
		authorAgentId: string,
		recipientId: string,
	): PublicationJob {
		for (const value of [worldId, intentId, authorAgentId, recipientId])
			identifier(value);
		const id = publicationJobId(worldId, intentId, authorAgentId, recipientId);
		if (this.row(worldId, id)) return this.get(worldId, id);
		return this.save({
			version: 1,
			id,
			worldId,
			revision: 1,
			intentId,
			authorAgentId,
			recipientId,
			attempt: 1,
			attemptId: publicationAttemptId(id, 1),
			status: "pending",
			material: null,
			author: null,
			modelSettingsRevision: null,
			decision: null,
			postId: null,
			error: null,
		});
	}
	discoverReply(
		worldId: string,
		parentPostId: string,
		authorAgentId: string,
		recipientId: string,
	): PublicationJob {
		for (const value of [worldId, parentPostId, authorAgentId, recipientId])
			identifier(value);
		const id = publicationReplyJobId(
			worldId,
			parentPostId,
			authorAgentId,
			recipientId,
		);
		if (this.row(worldId, id)) return this.get(worldId, id);
		return this.save({
			version: 2,
			id,
			worldId,
			revision: 1,
			source: { kind: "reply", parentPostId },
			authorAgentId,
			recipientId,
			attempt: 1,
			attemptId: publicationAttemptId(id, 1),
			status: "pending",
			material: null,
			author: null,
			modelSettingsRevision: null,
			decision: null,
			postId: null,
			error: null,
		});
	}
	freeze(
		worldId: string,
		jobId: string,
		material: PublicationMaterial,
		author: PublicationAuthor,
		modelSettingsRevision: number,
		modelSelection?: LifeModelSelection,
	): PublicationJob {
		const current = this.get(worldId, jobId),
			source = {
				material: parsePublicationMaterial(material),
				author: parsePublicationAuthor(author),
				modelSettingsRevision: revision(modelSettingsRevision),
				...(modelSelection === undefined
					? {}
					: { modelSelection: parseLifeModelSelection(modelSelection) }),
			};
		if (current.version !== source.material.version)
			throw Error("Publication job material version mismatch");
		if (current.status === "prepared") {
			if (
				lifeDigest(source) !==
				lifeDigest({
					material: current.material,
					author: current.author,
					modelSettingsRevision: current.modelSettingsRevision,
					...(current.modelSelection === undefined
						? {}
						: { modelSelection: current.modelSelection }),
				})
			)
				throw Error("Publication preparation conflict");
			return current;
		}
		if (current.version === 1 && source.material.version === 1)
			return this.save({
				...current,
				...source,
				material: source.material,
				revision: revision(current.revision + 1, 1),
				status: "prepared",
			});
		if (current.version === 2 && source.material.version === 2)
			return this.save({
				...current,
				...source,
				material: source.material,
				revision: revision(current.revision + 1, 1),
				status: "prepared",
			});
		throw Error("Publication job material version mismatch");
	}
	ready(
		worldId: string,
		jobId: string,
		value: PublicationDecision,
	): PublicationJob {
		const current = this.get(worldId, jobId),
			decision = parsePublicationDecision(
				value,
				current.material?.allowedClaims.map((c) => c.id) ?? [],
				current.version === 2 ? "reply" : "event",
			);
		if (
			current.status === "ready" &&
			lifeDigest(current.decision) === lifeDigest(decision)
		)
			return current;
		return this.save({
			...current,
			revision: revision(current.revision + 1, 1),
			status: "ready",
			decision,
			error: null,
		});
	}
	complete(
		worldId: string,
		jobId: string,
		postId: string | null,
	): PublicationJob {
		const current = this.get(worldId, jobId),
			status = postId === null ? "skipped" : "published";
		if (current.status === status && current.postId === postId) return current;
		return this.save({
			...current,
			revision: revision(current.revision + 1, 1),
			status,
			postId,
		});
	}
	withhold(
		worldId: string,
		jobId: string,
		error: string,
		failed = false,
	): PublicationJob {
		const current = this.get(worldId, jobId);
		identifier(error);
		if (
			current.status === (failed ? "failed" : "withheld") &&
			current.error === error
		)
			return current;
		return this.save({
			...current,
			revision: revision(current.revision + 1, 1),
			status: failed ? "failed" : "withheld",
			error,
			decision: null,
		});
	}
	unknown(worldId: string, jobId: string): PublicationJob {
		const current = this.get(worldId, jobId);
		if (current.status === "unknown") return current;
		return this.save({
			...current,
			revision: revision(current.revision + 1, 1),
			status: "unknown",
			error: "model_unknown",
		});
	}
	retry(
		worldId: string,
		jobId: string,
		input: { requestKey: string; expectedRevision: number },
	): PublicationJob {
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedRevision"]);
		identifier(input.requestKey);
		revision(input.expectedRevision, 1);
		const current = this.get(worldId, jobId),
			payload = lifeDigest({ jobId, ...input }),
			prior = this.db
				.prepare(
					"SELECT * FROM life_publication_job_requests WHERE world_id=? AND request_key=?",
				)
				.get(worldId, input.requestKey);
		if (prior) {
			if (prior["payload_digest"] !== payload)
				throw Error("Publication retry request conflict");
			return current;
		}
		if (
			current.revision !== input.expectedRevision ||
			!["failed", "withheld"].includes(current.status)
		)
			throw Error("Publication retry requires current eligible outcome");
		const { modelSelection: _selection, ...retrySource } = current;
		const attempt = revision(current.attempt + 1, 1),
			next = this.save({
				...retrySource,
				revision: revision(current.revision + 1, 1),
				attempt,
				attemptId: publicationAttemptId(jobId, attempt),
				status: "pending",
				material: null,
				author: null,
				modelSettingsRevision: null,
				decision: null,
				postId: null,
				error: null,
			});
		this.db
			.prepare(
				"INSERT INTO life_publication_job_requests(world_id,request_key,job_id,expected_revision,result_revision,payload_digest) VALUES(?,?,?,?,?,?)",
			)
			.run(
				worldId,
				input.requestKey,
				jobId,
				input.expectedRevision,
				next.revision,
				payload,
			);
		return next;
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id,job_id FROM life_publication_jobs UNION SELECT world_id,job_id FROM life_publication_job_history",
			)
			.all()) {
			const worldId = String(row["world_id"]),
				jobId = String(row["job_id"]);
			for (const job of this.history(worldId, jobId)) {
				if (job.status !== "pending" || job.attempt === 1) continue;
				const count = this.db
					.prepare(
						"SELECT COUNT(*) AS count FROM life_publication_job_requests WHERE world_id=? AND job_id=? AND result_revision=?",
					)
					.get(worldId, jobId, job.revision)?.["count"];
				if (count !== 1)
					throw Error("Missing or duplicate publication retry receipt");
			}
		}
		for (const row of this.db
			.prepare("SELECT * FROM life_publication_job_requests")
			.all()) {
			const worldId = identifier(row["world_id"]),
				jobId = identifier(row["job_id"]),
				requestKey = identifier(row["request_key"]),
				expectedRevision = revision(row["expected_revision"], 1),
				resultRevision = revision(row["result_revision"], 1);
			const target = this.db
				.prepare(
					"SELECT * FROM life_publication_job_history WHERE world_id=? AND job_id=? AND revision=?",
				)
				.get(worldId, jobId, resultRevision) as Row | undefined;
			if (
				!target ||
				decode(target).status !== "pending" ||
				resultRevision !== expectedRevision + 1 ||
				row["payload_digest"] !==
					lifeDigest({ jobId, requestKey, expectedRevision })
			)
				throw Error("Corrupt publication retry receipt");
		}
	}
}
