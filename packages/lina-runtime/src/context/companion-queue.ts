import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BotBinding } from "../../../lina-core/src/protocol.ts";
import {
	openCheckedDatabase,
	validateBinding,
} from "../../../lina-core/src/session-binding.ts";
import {
	captureSourceProofs,
	type SourceLookup,
	type SourceProof,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import { SourceEpisodeError } from "./companion-provenance.ts";
import { initializeCompanion } from "./companion-queue-schema.ts";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const JOB_BATCH = 20;
// Cross-process ownership is the existing session-app lease, held until memory.close().
// This also catches duplicate construction inside that owner; it is not another lease.
const owners = new Set<string>();
export interface CompanionScan {
	after: number;
	user: string | null;
	assistant: string | null;
}
export interface CompanionJob {
	id: string;
	sources: string[];
	sourceProofs?: SourceProof[];
}

/** Open/recover only under the app's session lease. Sources and scan progress commit together. */
export class CompanionQueue {
	private readonly db: DatabaseSync;
	private readonly path: string;
	private readonly now: () => number;
	private closed = false;
	private readonly lookup: SourceLookup;
	private readonly validateEpisode:
		| ((id: string, proofs: SourceProof[]) => void)
		| undefined;
	constructor(
		path: string,
		binding: BotBinding,
		options: {
			now?: () => number;
			lookup?: SourceLookup;
			validateEpisode?: (id: string, proofs: SourceProof[]) => void;
		} = {},
	) {
		this.path = resolve(path);
		if (owners.has(this.path))
			throw Error("Companion queue already has an owner");
		const owner = validateBinding(binding);
		this.now = options.now ?? Date.now;
		this.lookup = options.lookup ?? (() => undefined);
		this.validateEpisode = options.validateEpisode;
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		try {
			this.db.exec("BEGIN IMMEDIATE");
			initializeCompanion(this.db, opened.fresh, owner);
			// An interrupted attempt has no provider verdict; retain it in history
			// and replace its allowance instead of silently exhausting work.
			this.db.exec(
				"UPDATE companion_job_meta SET allowance=allowance+1 WHERE id IN (SELECT id FROM companion_jobs WHERE state='running')",
			);
			// Keep consumed attempts. Even the last interrupted attempt gets receipt reconciliation.
			this.db.exec(
				"UPDATE companion_jobs SET state='pending' WHERE state='running'; COMMIT; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL",
			);
			owners.add(this.path);
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}
	scanState(): CompanionScan {
		const row = this.db
			.prepare(
				"SELECT cursor,user_id,assistant_id FROM companion_meta WHERE id=1",
			)
			.get();
		return {
			after: Number(row?.["cursor"]),
			user: row?.["user_id"] === null ? null : String(row?.["user_id"]),
			assistant:
				row?.["assistant_id"] === null ? null : String(row?.["assistant_id"]),
		};
	}
	cursor(): number {
		return this.scanState().after;
	}
	checkpoint(state: CompanionScan, completed?: CompanionJob): void {
		this.transaction(() => {
			if (completed) this.insert(completed);
			this.advance(state.after);
			this.db
				.prepare(
					"UPDATE companion_meta SET user_id=?,assistant_id=? WHERE id=1",
				)
				.run(state.user, state.assistant);
		});
	}
	add(id: string, sources: string[], cursor: number): void {
		this.transaction(() => {
			this.insert({ id, sources });
			this.advance(cursor);
		});
	}
	private insert({ id, sources }: CompanionJob): void {
		if (
			!id.trim() ||
			id.length > 256 ||
			sources.length > 50 ||
			!sources.length ||
			!sources.every(
				(s) => typeof s === "string" && s.trim().length > 0 && s.length <= 256,
			)
		)
			throw Error("Invalid companion job");
		const existing = this.db
			.prepare("SELECT sources FROM companion_jobs WHERE id=?")
			.get(id);
		const encoded = JSON.stringify(sources);
		if (existing && existing["sources"] !== encoded)
			throw Error("Companion job source conflict");
		this.db
			.prepare(
				"INSERT INTO companion_jobs VALUES (?,?,'pending',0,0,NULL,?,NULL) ON CONFLICT(id) DO NOTHING",
			)
			.run(id, encoded, this.capture(sources));
		this.db
			.prepare(
				"INSERT INTO companion_job_meta VALUES (?,3,NULL,NULL) ON CONFLICT(id) DO NOTHING",
			)
			.run(id);
	}
	advance(cursor: number): void {
		if (!Number.isSafeInteger(cursor) || cursor < 0)
			throw Error("Invalid queue cursor");
		this.db
			.prepare("UPDATE companion_meta SET cursor=max(cursor,?) WHERE id=1")
			.run(cursor);
	}
	pending(): CompanionJob[] {
		this.revalidate();
		return this.db
			.prepare(
				"SELECT j.id,j.sources,j.source_proofs FROM companion_jobs j JOIN companion_job_meta m ON m.id=j.id WHERE state='pending' OR (state='failed' AND attempts<m.allowance AND retry_at<=?) ORDER BY j.rowid LIMIT ?",
			)
			.all(this.now(), JOB_BATCH)
			.map((r) => ({
				id: String(r["id"]),
				sources: JSON.parse(String(r["sources"])) as string[],
				sourceProofs: JSON.parse(String(r["source_proofs"])) as SourceProof[],
			}));
	}
	/** Queue completion is not evidence of an engine commit. Audit in bounded pages. */
	reconcileReceipts(hasReceipt: (id: string) => boolean): boolean {
		this.revalidate();
		for (const row of this.db
			.prepare("SELECT id FROM companion_jobs WHERE state='done'")
			.iterate()) {
			const id = String(row["id"]);
			if (!hasReceipt(id))
				this.db
					.prepare("UPDATE companion_jobs SET state='pending' WHERE id=?")
					.run(id);
		}
		return false;
	}
	start(id: string): boolean {
		this.revalidate();
		return this.transaction(() => {
			const started =
				Number(
					this.db
						.prepare(
							"UPDATE companion_jobs SET state='running',attempts=attempts+1 WHERE id=? AND state IN ('pending','failed') AND attempts<(SELECT allowance FROM companion_job_meta WHERE id=?) AND retry_at<=?",
						)
						.run(id, id, this.now()).changes,
				) === 1;
			if (started) this.event(id, "start", null);
			return started;
		});
	}
	private event(id: string, event: string, error: string | null): void {
		this.db
			.prepare(
				"INSERT INTO companion_history(id,event,attempt,at,error) SELECT id,?,attempts,?,? FROM companion_jobs WHERE id=?",
			)
			.run(event, this.now(), error, id);
	}
	resetBaseline(id: string, revision: number): number {
		this.db
			.prepare(
				"UPDATE companion_job_meta SET reset_revision=coalesce(reset_revision,?) WHERE id=?",
			)
			.run(revision, id);
		return Number(
			this.db
				.prepare("SELECT reset_revision FROM companion_job_meta WHERE id=?")
				.get(id)?.["reset_revision"],
		);
	}
	markChanged(id: string): void {
		this.db
			.prepare("UPDATE companion_job_meta SET outcome='changed' WHERE id=?")
			.run(id);
	}

	recover(ids: string[], reason: string): number {
		if (!reason.trim() || reason.length > 256 || ids.length > 1000)
			throw Error("Invalid recovery request");
		this.revalidate();
		let n = 0;
		this.transaction(() => {
			for (const id of new Set(ids)) {
				if (
					this.db
						.prepare(
							"SELECT 1 FROM companion_history WHERE id=? AND event='recovery' AND error=?",
						)
						.get(id, reason)
				)
					continue;
				const row = this.db
					.prepare(
						"SELECT j.state,j.attempts,m.allowance FROM companion_jobs j JOIN companion_job_meta m ON m.id=j.id WHERE j.id=?",
					)
					.get(id);
				if (
					row?.["state"] !== "failed" ||
					Number(row["attempts"]) < Number(row["allowance"])
				)
					continue;
				this.event(id, "recovery", reason);
				this.db
					.prepare(
						"UPDATE companion_job_meta SET allowance=allowance+? WHERE id=?",
					)
					.run(MAX_ATTEMPTS, id);
				this.db
					.prepare(
						"UPDATE companion_jobs SET state='pending',retry_at=0 WHERE id=?",
					)
					.run(id);
				n++;
			}
		});
		return n;
	}
	processing() {
		this.revalidate();
		const value = {
			changed: 0,
			unchanged: 0,
			retrying: 0,
			failed: 0,
			processedUnknown: 0,
			withheld: 0,
		};
		for (const row of this.db
			.prepare(
				"SELECT j.state,j.attempts,m.allowance,m.outcome FROM companion_jobs j JOIN companion_job_meta m ON j.id=m.id",
			)
			.all()) {
			if (row["state"] === "done") {
				if (row["outcome"] === "changed") value.changed++;
				else if (row["outcome"] === "unchanged") value.unchanged++;
				else value.processedUnknown++;
			} else if (row["state"] === "withheld") value.withheld++;
			else if (row["state"] === "failed") {
				if (Number(row["attempts"]) < Number(row["allowance"]))
					value.retrying++;
				else value.failed++;
			}
		}
		return value;
	}
	jobError(id: string): string | null {
		const error = this.db
			.prepare("SELECT error FROM companion_jobs WHERE id=?")
			.get(id)?.["error"];
		return typeof error === "string" ? error : null;
	}

	latestError(): string | null {
		const row = this.db
			.prepare(
				"SELECT error,event FROM companion_history WHERE event IN ('changed','unchanged','done','failed') ORDER BY seq DESC LIMIT 1",
			)
			.get();
		return row?.["event"] === "failed" && typeof row["error"] === "string"
			? row["error"]
			: null;
	}

	finish(
		id: string,
		ok: boolean,
		error: string | null = null,
		outcome: "changed" | "unchanged" | "done" = "done",
	): void {
		this.revalidate();
		this.transaction(() => {
			const row = this.db
				.prepare("SELECT attempts,state FROM companion_jobs WHERE id=?")
				.get(id);
			if (!row) throw Error("Unknown companion job");
			if (row["state"] === "withheld") return;
			const delay = Math.min(
				RETRY_MAX_MS,
				RETRY_BASE_MS * 2 ** Math.max(0, Number(row["attempts"]) - 1),
			);
			this.db
				.prepare(
					"UPDATE companion_jobs SET state=?,retry_at=?,error=? WHERE id=?",
				)
				.run(
					ok ? "done" : "failed",
					ok ? 0 : this.now() + delay,
					ok ? null : (error ?? "observation_failed"),
					id,
				);
			this.db
				.prepare(
					"UPDATE companion_job_meta SET outcome=CASE WHEN outcome='changed' THEN outcome ELSE ? END,allowance=allowance+? WHERE id=?",
				)
				.run(
					ok ? outcome : null,
					error === "observation_cancelled" ? 1 : 0,
					id,
				);
			this.event(id, ok ? outcome : "failed", error);
		});
	}
	nextDelay(): number | undefined {
		const row = this.db
			.prepare(
				"SELECT min(CASE WHEN state='pending' THEN 0 ELSE retry_at END) AS due FROM companion_jobs j JOIN companion_job_meta m ON j.id=m.id WHERE state='pending' OR (state='failed' AND attempts<m.allowance)",
			)
			.get();
		return row?.["due"] === null
			? undefined
			: Math.max(0, Number(row?.["due"]) - this.now());
	}
	error(): string | null {
		const row = this.db
			.prepare(
				"SELECT error FROM companion_jobs WHERE error IS NOT NULL ORDER BY rowid LIMIT 1",
			)
			.get();
		return typeof row?.["error"] === "string" ? row["error"] : null;
	}
	counts() {
		this.revalidate();
		const result = {
			pending: 0,
			sending: 0,
			accepted: 0,
			unknown: 0,
			withheld: 0,
			failed: 0,
		};
		for (const row of this.db
			.prepare("SELECT state,count(*) AS n FROM companion_jobs GROUP BY state")
			.all()) {
			const n = Number(row["n"]);
			switch (row["state"]) {
				case "pending":
					result.pending = n;
					break;
				case "running":
					result.sending = n;
					break;
				case "done":
					result.accepted = n;
					break;
				case "withheld":
					result.withheld = n;
					break;
				case "failed":
					result.failed = n;
					break;
			}
		}
		return result;
	}
	private capture(sources: string[]): string | null {
		try {
			return JSON.stringify(captureSourceProofs(sources, this.lookup));
		} catch {
			return null;
		}
	}
	withhold(id: string, reason = "source_provenance_ineligible_or_stale"): void {
		this.transaction(() => {
			const result = this.db
				.prepare(
					"UPDATE companion_jobs SET state='withheld',withheld_reason=? WHERE id=? AND state!='withheld'",
				)
				.run(reason, id);
			if (Number(result.changes)) this.event(id, "withheld", reason);
		});
	}
	private revalidate(): void {
		for (const row of this.db
			.prepare(
				"SELECT id,source_proofs FROM companion_jobs WHERE state!='withheld'",
			)
			.all()) {
			const proofs =
				row["source_proofs"] === null
					? []
					: JSON.parse(String(row["source_proofs"]));
			try {
				this.validateEpisode?.(String(row["id"]), proofs);
				if (!sourceProofsCurrent(proofs, this.lookup))
					throw new SourceEpisodeError();
			} catch (error) {
				if (!(error instanceof SourceEpisodeError)) throw error;
				this.withhold(String(row["id"]));
			}
		}
	}
	close(): void {
		if (this.closed) return;
		this.db.close();
		owners.delete(this.path);
		this.closed = true;
	}
	private transaction<T>(action: () => T): T {
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
