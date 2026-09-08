import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
	engineIdSchema,
	hash,
	revisionSchema,
	validTime,
} from "./validation.ts";

export const CONSOLIDATION_SCHEMA = `
CREATE TABLE engine_reasoning_jobs (id TEXT PRIMARY KEY, input_fingerprint TEXT NOT NULL UNIQUE, seed TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','running','committed','failed','withheld')), claim_token TEXT, attempts INTEGER NOT NULL, retry_at INTEGER NOT NULL, error TEXT, result_revision INTEGER) STRICT;
`;
const seedSchema = z.strictObject({
	trigger: z.string().regex(/^[a-f0-9]{64}$/),
	stage: z.enum(["deduction", "induction"]),
	page: revisionSchema,
	policyRevision: revisionSchema,
	modelSettingsRevision: revisionSchema,
	maxAttempts: z.number().int().min(1).max(3),
});
export type ConsolidationSeed = z.infer<typeof seedSchema>;
export interface ConsolidationClaim {
	id: string;
	token: string;
	attempt: number;
	seed: ConsolidationSeed;
}
export interface ConsolidationJob {
	id: string;
	seed: ConsolidationSeed;
	state: "pending" | "running" | "committed" | "failed" | "withheld";
	token: string | null;
	attempts: number;
	retryAt: number;
	error: string | null;
	resultRevision: number | null;
}
const states = z.enum([
	"pending",
	"running",
	"committed",
	"failed",
	"withheld",
]);
const errors = z.enum([
	"provider_failed",
	"stale_revision",
	"interrupted_outcome_unknown",
	"superseded",
	"source_withheld",
	"cancelled",
	"invalid_output",
	"configuration_changed",
	"search_budget_exhausted",
	"input_budget_insufficient",
	"character_growth_disabled",
]);
export type ConsolidationError = z.infer<typeof errors>;

/** No connection, lease or timer ownership. EngineStore owns the enclosing transaction. */
export class ConsolidationQueue {
	constructor(
		private readonly db: DatabaseSync,
		private readonly now: () => number = Date.now,
	) {
		for (const row of db
			.prepare("SELECT * FROM engine_reasoning_jobs")
			.iterate())
			this.decode(row);
	}
	enqueue(input: ConsolidationSeed): ConsolidationJob {
		const seed = seedSchema.parse(input);
		const fingerprint = hash([
			seed.trigger,
			seed.stage,
			seed.page,
			seed.policyRevision,
			seed.modelSettingsRevision,
		]);
		const id = `reasoning-${fingerprint}`;
		return this.transaction(() => {
			const prior = this.get(id);
			if (prior) {
				if (hash(prior.seed) !== hash(seed))
					throw Error("reasoning job binding conflict");
				if (prior.state === "withheld" && prior.error === "superseded") {
					this.db
						.prepare(
							"UPDATE engine_reasoning_jobs SET state='pending',error=NULL,retry_at=0 WHERE id=?",
						)
						.run(id);
					return this.required(id);
				}
				return prior;
			}
			this.db
				.prepare(
					"INSERT INTO engine_reasoning_jobs VALUES (?,?,?,'pending',NULL,0,0,NULL,NULL)",
				)
				.run(id, fingerprint, JSON.stringify(seed));
			return this.required(id);
		});
	}
	get(id: string): ConsolidationJob | undefined {
		const row = this.db
			.prepare("SELECT * FROM engine_reasoning_jobs WHERE id=?")
			.get(engineIdSchema.parse(id));
		return row ? this.decode(row) : undefined;
	}
	pending(limit = 20): ConsolidationJob[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
			throw Error("invalid reasoning job limit");
		const now = validTime(this.now);
		return this.db
			.prepare(
				"SELECT * FROM engine_reasoning_jobs WHERE state IN ('pending','failed') AND retry_at<=? ORDER BY rowid",
			)
			.all(now)
			.map((row) => this.decode(row))
			.filter((job) => job.attempts < job.seed.maxAttempts)
			.slice(0, limit);
	}
	claim(id: string): ConsolidationClaim | undefined {
		return this.transaction(() => {
			const job = this.required(id);
			if (
				!["pending", "failed"].includes(job.state) ||
				job.attempts >= job.seed.maxAttempts ||
				job.retryAt > validTime(this.now)
			)
				return undefined;
			const token = randomUUID();
			const result = this.db
				.prepare(
					"UPDATE engine_reasoning_jobs SET state='running',claim_token=?,attempts=attempts+1,error=NULL WHERE id=? AND state=? AND attempts=?",
				)
				.run(token, id, job.state, job.attempts);
			if (result.changes !== 1) return undefined;
			return { id, token, attempt: job.attempts + 1, seed: job.seed };
		});
	}
	assertClaim(claim: ConsolidationClaim): ConsolidationJob {
		const job = this.required(claim.id);
		if (
			job.state !== "running" ||
			job.token !== claim.token ||
			job.attempts !== claim.attempt ||
			hash(job.seed) !== hash(seedSchema.parse(claim.seed))
		)
			throw Error("stale reasoning claim");
		return job;
	}
	finish(
		claim: ConsolidationClaim,
		state: "committed" | "failed" | "withheld",
		revision: number | null,
		error?: string,
	): void {
		this.transaction(() => {
			this.assertClaim(claim);
			if (state === "committed") {
				if (
					revision === null ||
					revisionSchema.parse(revision) < 1 ||
					error !== undefined
				)
					throw Error("invalid reasoning outcome");
			} else if (revision !== null || error === undefined)
				throw Error("invalid reasoning outcome");
			const code = error === undefined ? null : errors.parse(error);
			const retryAt =
				state === "failed"
					? validTime(
							() =>
								validTime(this.now) +
								Math.min(30000, 1000 * 2 ** (claim.attempt - 1)),
						)
					: 0;
			this.db
				.prepare(
					"UPDATE engine_reasoning_jobs SET state=?,claim_token=NULL,retry_at=?,error=?,result_revision=? WHERE id=?",
				)
				.run(state, retryAt, code, revision, claim.id);
		});
	}
	/** Caller holds the app lease; no elapsed timeout is used as proof a provider did not run. */
	recover(receiptRevision: (id: string) => number | undefined): void {
		this.transaction(() => {
			const jobs = this.db
				.prepare("SELECT * FROM engine_reasoning_jobs")
				.all()
				.map((row) => this.decode(row));
			for (const job of jobs) {
				const receipt = receiptRevision(job.id);
				if (receipt !== undefined) {
					if (
						revisionSchema.parse(receipt) < 1 ||
						(job.resultRevision !== null && job.resultRevision !== receipt)
					)
						throw Error("reasoning receipt mismatch");
					this.db
						.prepare(
							"UPDATE engine_reasoning_jobs SET state='committed',claim_token=NULL,retry_at=0,error=NULL,result_revision=? WHERE id=?",
						)
						.run(receipt, job.id);
				} else if (job.state === "committed")
					throw Error("missing reasoning receipt");
				else if (job.state === "running")
					this.db
						.prepare(
							"UPDATE engine_reasoning_jobs SET state='failed',claim_token=NULL,retry_at=0,error='interrupted_outcome_unknown' WHERE id=?",
						)
						.run(job.id);
			}
		});
	}
	supersede(currentTrigger: string): void {
		if (!/^[a-f0-9]{64}$/.test(currentTrigger))
			throw Error("invalid reasoning trigger");
		this.transaction(() => {
			for (const row of this.db
				.prepare(
					"SELECT * FROM engine_reasoning_jobs WHERE state IN ('pending','running','failed')",
				)
				.all()) {
				const job = this.decode(row);
				if (job.seed.trigger !== currentTrigger)
					this.db
						.prepare(
							"UPDATE engine_reasoning_jobs SET state='withheld',claim_token=NULL,retry_at=0,error='superseded' WHERE id=?",
						)
						.run(job.id);
			}
		});
	}
	private required(id: string): ConsolidationJob {
		const job = this.get(id);
		if (!job) throw Error("unknown reasoning job");
		return job;
	}
	private decode(row: Record<string, unknown>): ConsolidationJob {
		const seed = seedSchema.parse(JSON.parse(String(row["seed"])));
		const fingerprint = hash([
			seed.trigger,
			seed.stage,
			seed.page,
			seed.policyRevision,
			seed.modelSettingsRevision,
		]);
		const state = states.parse(row["state"]);
		const token =
			row["claim_token"] === null
				? null
				: engineIdSchema.parse(row["claim_token"]);
		const attempts = revisionSchema.parse(row["attempts"]);
		const retryAt = validTime(() => Number(row["retry_at"]));
		const error = row["error"] === null ? null : errors.parse(row["error"]);
		const resultRevision =
			row["result_revision"] === null
				? null
				: revisionSchema.parse(row["result_revision"]);
		if (
			row["id"] !== `reasoning-${fingerprint}` ||
			row["input_fingerprint"] !== fingerprint ||
			attempts > seed.maxAttempts ||
			(state === "running") !== (token !== null) ||
			(state === "running" && attempts < 1) ||
			(state === "committed") !== (resultRevision !== null) ||
			(resultRevision !== null && resultRevision < 1) ||
			(state === "failed" || state === "withheld") !== (error !== null)
		)
			throw Error("invalid persisted reasoning job");
		return {
			id: String(row["id"]),
			seed,
			state,
			token,
			attempts,
			retryAt,
			error,
			resultRevision,
		};
	}
	private transaction<T>(action: () => T): T {
		if (this.db.isTransaction) return action();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = action();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
