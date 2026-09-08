import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	auditBehavior,
	decodeBehaviorJob,
	decodeBehaviorReceipt,
} from "./behavior-audit.ts";
import type {
	BehaviorClaim,
	BehaviorFailReason,
	BehaviorJob,
	BehaviorJobInput,
	BehaviorPersistence,
	BehaviorProfileGetter,
	BehaviorReceipt,
	BehaviorSourceStamp,
	BehaviorSourceVerifier,
	BehaviorTransaction,
	CurrentBehaviorProjection,
	PersonalBehavior,
} from "./behavior-types.ts";
import {
	behaviorDigest,
	behaviorFingerprint,
	parseBehaviorFailReason,
	parseBehaviorJobInput,
	parsePersonalBehaviorOutput,
	projectPersonalBehavior,
} from "./behavior-validation.ts";

export const AGENT_BEHAVIOR_SCHEMA = `
CREATE TABLE agent_behavior_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), world_id TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','prepared','committed','failed','withheld')), claim_token TEXT, attempts INTEGER NOT NULL, error TEXT, result_revision INTEGER) STRICT;
CREATE TABLE agent_behavior_receipts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES agent_behavior_jobs(id), agent_id TEXT NOT NULL REFERENCES agent_profiles(id), world_id TEXT NOT NULL, revision INTEGER NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL, prompt_digest TEXT NOT NULL, stamp_json TEXT NOT NULL) STRICT;
`;

function requireVerifier(
	assertCurrent: BehaviorSourceVerifier,
): BehaviorSourceVerifier {
	if (typeof assertCurrent !== "function")
		throw Error("behavior source current verifier required");
	return assertCurrent;
}

function withheld(reason: BehaviorFailReason): boolean {
	return (
		reason === "configuration_changed" ||
		reason === "source_withheld" ||
		reason === "cancelled"
	);
}

function stampFor(
	receipts: BehaviorReceipt[],
	personalBehavior: PersonalBehavior,
	fallback: BehaviorReceipt,
): BehaviorSourceStamp {
	const selected = receipts.length ? receipts : [fallback];
	const latest = selected[selected.length - 1] ?? fallback;
	return {
		digest: behaviorDigest({
			receipts: selected.map((receipt) => ({
				id: receipt.id,
				revision: receipt.revision,
				output: projectPersonalBehavior(receipt.output),
			})),
			personalBehavior,
		}),
		receiptRevision: latest.revision,
		profileRevision: latest.input.profileRevision,
		definitionRevision: latest.input.definitionRevision,
		projectionRevision: latest.input.projectionRevision,
	};
}

export class BehaviorStore implements BehaviorPersistence {
	constructor(
		private readonly db: DatabaseSync,
		private readonly transaction: BehaviorTransaction,
		private readonly profile: BehaviorProfileGetter,
	) {
		if (typeof profile !== "function" || typeof transaction !== "function")
			throw Error("invalid behavior store arguments");
		auditBehavior(db, profile);
	}

	enqueue(input: BehaviorJobInput): BehaviorJob {
		const parsed = parseBehaviorJobInput(input);
		const profile = this.profile(parsed.agentId);
		if (!profile) throw Error("unknown behavior agent");
		if (profile.revision !== parsed.profileRevision)
			throw Error("stale behavior profile revision");
		const fingerprint = behaviorFingerprint(parsed);
		const id = "behavior-" + fingerprint;
		return this.transaction(() => {
			const prior = this.getJob(id);
			if (prior) {
				if (
					prior.agentId !== parsed.agentId ||
					prior.worldId !== parsed.worldId
				)
					throw Error("behavior job binding conflict");
				return prior;
			}
			this.db
				.prepare(
					"INSERT INTO agent_behavior_jobs VALUES (?,?,?,?,?,'pending',NULL,0,NULL,NULL)",
				)
				.run(
					id,
					parsed.agentId,
					parsed.worldId,
					fingerprint,
					JSON.stringify(parsed),
				);
			return this.requiredJob(id);
		});
	}

	claim(jobId: string, expectedRevision: number): BehaviorClaim | undefined {
		if (
			typeof expectedRevision !== "number" ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 0
		)
			throw Error("invalid expected revision");
		return this.transaction(() => {
			const job = this.getJob(jobId);
			if (!job) return undefined;
			if (!["pending", "failed"].includes(job.state)) return undefined;
			if (job.attempts >= job.input.maxAttempts) return undefined;
			if (this.revision(job.agentId, job.worldId) !== expectedRevision)
				return undefined;
			const token = randomUUID();
			const result = this.db
				.prepare(
					"UPDATE agent_behavior_jobs SET state='prepared',claim_token=?,attempts=attempts+1,error=NULL WHERE id=? AND state=? AND attempts=?",
				)
				.run(token, jobId, job.state, job.attempts);
			if (result.changes !== 1) return undefined;
			return {
				id: jobId,
				token,
				attempt: job.attempts + 1,
				expectedRevision,
			};
		});
	}
	reactivate(
		jobId: string,
		assertCurrent: BehaviorSourceVerifier,
	): BehaviorJob {
		const verify = requireVerifier(assertCurrent);
		return this.transaction(() => {
			const job = this.requiredJob(jobId);
			if (
				job.state === "withheld" &&
				job.attempts < job.input.maxAttempts &&
				verify(job.input)
			)
				this.db
					.prepare(
						"UPDATE agent_behavior_jobs SET state='pending',error=NULL WHERE id=? AND state='withheld'",
					)
					.run(jobId);
			return this.requiredJob(jobId);
		});
	}

	commit(
		claim: BehaviorClaim,
		output: unknown,
		assertCurrent: BehaviorSourceVerifier,
	): BehaviorReceipt {
		const verify = requireVerifier(assertCurrent);
		return this.transaction(() => {
			const job = this.assertClaim(claim);
			if (this.revision(job.agentId, job.worldId) !== claim.expectedRevision)
				throw Error("stale behavior revision");
			if (!verify(job.input)) throw Error("behavior source is not current");
			const parsed = parsePersonalBehaviorOutput(output, job.input);
			const revision = this.revision(job.agentId, job.worldId) + 1;
			const receiptId = "behavior-receipt-" + job.id + "-" + String(revision);
			const stamp = {
				digest: behaviorDigest({
					receiptId,
					records: job.input.records.map((record) => ({
						recordId: record.recordId,
						contentHash: record.contentHash,
						proofDigest: record.proofDigest,
					})),
					output: parsed,
				}),
				receiptRevision: revision,
				profileRevision: job.input.profileRevision,
				definitionRevision: job.input.definitionRevision,
				projectionRevision: job.input.projectionRevision,
			};
			this.db
				.prepare(
					"INSERT INTO agent_behavior_receipts VALUES (?,?,?,?,?,?,?,?,?)",
				)
				.run(
					receiptId,
					job.id,
					job.agentId,
					job.worldId,
					revision,
					JSON.stringify(job.input),
					JSON.stringify(parsed),
					job.input.promptDigest,
					JSON.stringify(stamp),
				);
			const updated = this.db
				.prepare(
					"UPDATE agent_behavior_jobs SET state='committed',claim_token=NULL,result_revision=?,error=NULL WHERE id=? AND claim_token=?",
				)
				.run(revision, job.id, claim.token);
			if (updated.changes !== 1) throw Error("stale behavior claim");
			return this.requiredReceipt(job.id);
		});
	}

	fail(claim: BehaviorClaim, reason: BehaviorFailReason): BehaviorJob {
		const parsed = parseBehaviorFailReason(reason);
		return this.transaction(() => {
			this.assertClaim(claim);
			this.db
				.prepare(
					"UPDATE agent_behavior_jobs SET state=?,claim_token=NULL,error=? WHERE id=? AND claim_token=?",
				)
				.run(
					withheld(parsed) ? "withheld" : "failed",
					parsed,
					claim.id,
					claim.token,
				);
			return this.requiredJob(claim.id);
		});
	}

	recover(): void {
		this.transaction(() => {
			for (const job of this.allJobs()) {
				if (job.state !== "prepared") continue;
				this.db
					.prepare(
						"UPDATE agent_behavior_jobs SET state='failed',claim_token=NULL,error=? WHERE id=?",
					)
					.run("interrupted_outcome_unknown", job.id);
			}
		});
	}

	get(jobId: string): BehaviorJob | undefined {
		return this.getJob(jobId);
	}

	revision(agentId: string, worldId: string): number {
		const row = this.db
			.prepare(
				"SELECT max(revision) AS n FROM agent_behavior_receipts WHERE agent_id=? AND world_id=?",
			)
			.get(agentId, worldId);
		return Number(row?.["n"] ?? 0);
	}

	audit(): void {
		auditBehavior(this.db, this.profile);
	}

	current(
		agentId: string,
		worldId: string,
		assertCurrent: BehaviorSourceVerifier,
	): CurrentBehaviorProjection {
		const verify = requireVerifier(assertCurrent);
		const currentProfile = this.profile(agentId);
		if (!currentProfile || currentProfile.evolution === "manual")
			return { agentId, worldId, personalBehavior: null, sourceStamp: null };
		const receipts = this.receipts(agentId, worldId);
		const traits = new Map<string, number>();
		const habits = new Map<string, boolean>();
		const winners = new Map<string, BehaviorReceipt>();
		let latestEligible: BehaviorReceipt | undefined;
		for (const receipt of receipts) {
			const eligible =
				receipt.input.profileRevision === currentProfile.revision &&
				verify(receipt.input);
			if (eligible) latestEligible = receipt;
			for (const trait of receipt.output.traits) {
				if (!eligible) {
					traits.delete(trait.axisId);
					winners.delete("trait:" + trait.axisId);
					continue;
				}
				traits.set(trait.axisId, trait.value);
				winners.set("trait:" + trait.axisId, receipt);
			}
			for (const habit of receipt.output.habits) {
				if (!eligible) {
					habits.delete(habit.habitId);
					winners.delete("habit:" + habit.habitId);
					continue;
				}
				habits.set(habit.habitId, habit.value);
				winners.set("habit:" + habit.habitId, receipt);
			}
		}
		if (!latestEligible)
			return { agentId, worldId, personalBehavior: null, sourceStamp: null };
		const personalBehavior = {
			traits: [...traits.entries()].map(([axisId, value]) => ({
				axisId,
				value,
			})),
			habits: [...habits.entries()].map(([habitId, value]) => ({
				habitId,
				value,
			})),
		};
		const selected = [
			...new Map(
				[...winners.values()].map((receipt) => [receipt.id, receipt]),
			).values(),
		].sort((left, right) => left.revision - right.revision);
		return {
			agentId,
			worldId,
			personalBehavior,
			sourceStamp: stampFor(selected, personalBehavior, latestEligible),
		};
	}

	status(agentId: string): BehaviorJob[] {
		return this.allJobs().filter((job) => job.agentId === agentId);
	}

	private assertClaim(claim: BehaviorClaim): BehaviorJob {
		const job = this.requiredJob(claim.id);
		if (
			job.state !== "prepared" ||
			job.token !== claim.token ||
			job.attempts !== claim.attempt
		)
			throw Error("stale behavior claim");
		return job;
	}

	private getJob(id: string): BehaviorJob | undefined {
		const row = this.db
			.prepare("SELECT * FROM agent_behavior_jobs WHERE id=?")
			.get(id);
		return row ? this.decodeJob(row) : undefined;
	}

	private requiredJob(id: string): BehaviorJob {
		const job = this.getJob(id);
		if (!job) throw Error("missing behavior job");
		return job;
	}

	private requiredReceipt(jobId: string): BehaviorReceipt {
		const row = this.db
			.prepare("SELECT * FROM agent_behavior_receipts WHERE job_id=?")
			.get(jobId);
		if (!row) throw Error("missing behavior receipt");
		return this.decodeReceipt(row);
	}

	private receipts(agentId: string, worldId: string): BehaviorReceipt[] {
		return this.db
			.prepare(
				"SELECT * FROM agent_behavior_receipts WHERE agent_id=? AND world_id=? ORDER BY revision",
			)
			.all(agentId, worldId)
			.map((row) => this.decodeReceipt(row));
	}

	private allJobs(): BehaviorJob[] {
		return this.db
			.prepare("SELECT * FROM agent_behavior_jobs ORDER BY rowid")
			.all()
			.map((row) => this.decodeJob(row));
	}

	private decodeJob(row: Record<string, unknown>): BehaviorJob {
		return decodeBehaviorJob(row);
	}
	private decodeReceipt(row: Record<string, unknown>): BehaviorReceipt {
		return decodeBehaviorReceipt(row, this.requiredJob(String(row["job_id"])));
	}
}
