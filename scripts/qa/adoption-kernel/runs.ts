import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decodeDecision } from "./records.ts";
import type { KernelTrace } from "./types.ts";

function restoredTrace(
	value: unknown,
	decisionId: string,
	status: unknown,
): KernelTrace {
	if (typeof value !== "string") {
		if (value === null && status === "running")
			return { status: "unknown", decisionId };
		throw Error("invalid stored run");
	}
	const trace: unknown = JSON.parse(value);
	if (!trace || typeof trace !== "object" || Array.isArray(trace))
		throw Error("invalid stored run");
	const data = trace as Record<string, unknown>;
	if (
		Object.keys(data).some(
			(key) => !["status", "decisionId", "detail"].includes(key),
		) ||
		data["decisionId"] !== decisionId ||
		(typeof data["detail"] !== "undefined" &&
			typeof data["detail"] !== "string") ||
		![
			"rejected",
			"deferred",
			"noop",
			"answered",
			"adopted",
			"dispatched",
			"unknown",
		].includes(String(data["status"])) ||
		status !== (data["status"] === "unknown" ? "unknown" : "done")
	)
		throw Error("invalid stored run");
	return data as KernelTrace;
}

/** Durable invocation identity; unresolved calls never become implicit retries. */
export class RunReservations {
	constructor(
		private readonly db: DatabaseSync,
		private readonly decisionId: () => string = randomUUID,
	) {
		db.exec(
			"CREATE TABLE IF NOT EXISTS kernel_runs (request_id TEXT PRIMARY KEY, purpose_id TEXT NOT NULL, decision_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('running','unknown','done')), trace TEXT) STRICT; CREATE UNIQUE INDEX IF NOT EXISTS kernel_busy_purpose ON kernel_runs(purpose_id) WHERE status IN ('running','unknown')",
		);
	}
	claim(
		purposeId: string,
		requestId: string,
	): { decisionId: string; replay: KernelTrace | null } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const prior = this.db
				.prepare("SELECT * FROM kernel_runs WHERE request_id=?")
				.get(requestId);
			if (prior) {
				if (prior["purpose_id"] !== purposeId)
					throw Error("request identity belongs to another purpose");
				const decisionId = String(prior["decision_id"]);
				const replay = restoredTrace(
					prior["trace"],
					decisionId,
					prior["status"],
				);
				this.db.exec("COMMIT");
				return { decisionId, replay };
			}
			const busy = this.db
				.prepare(
					"SELECT decision_id FROM kernel_runs WHERE purpose_id=? AND status IN ('running','unknown')",
				)
				.get(purposeId);
			if (busy) {
				const decisionId = String(busy["decision_id"]);
				this.db.exec("COMMIT");
				return {
					decisionId,
					replay: {
						status: "unknown",
						decisionId,
						detail: "purpose has unresolved judgment",
					},
				};
			}
			const decisionId = this.decisionId();
			this.db
				.prepare("INSERT INTO kernel_runs VALUES (?,?,?,'running',NULL)")
				.run(requestId, purposeId, decisionId);
			this.db.exec("COMMIT");
			return { decisionId, replay: null };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	unresolved(): string[] {
		return this.db
			.prepare(
				"SELECT decision_id,status,trace FROM kernel_runs WHERE status IN ('running','unknown')",
			)
			.all()
			.map((row) => {
				const id = String(row["decision_id"]);
				restoredTrace(row["trace"], id, row["status"]);
				return id;
			});
	}
	finish(trace: KernelTrace): KernelTrace {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const prior = this.db
				.prepare("SELECT status,trace FROM kernel_runs WHERE decision_id=?")
				.get(trace.decisionId);
			if (prior?.["status"] === "done") {
				const terminal = restoredTrace(
					prior["trace"],
					trace.decisionId,
					prior["status"],
				);
				this.db.exec("COMMIT");
				return terminal;
			}
			const row = this.db
				.prepare("SELECT data FROM kernel_decisions WHERE id=?")
				.get(trace.decisionId);
			if (row) {
				const data = decodeDecision(row["data"]);
				if (data["status"] !== "resumed")
					this.db
						.prepare("UPDATE kernel_decisions SET data=? WHERE id=?")
						.run(
							JSON.stringify({ ...data, status: trace.status }),
							trace.decisionId,
						);
			}
			this.db
				.prepare("UPDATE kernel_runs SET status=?,trace=? WHERE decision_id=?")
				.run(
					trace.status === "unknown" ? "unknown" : "done",
					JSON.stringify(trace),
					trace.decisionId,
				);
			this.db.exec("COMMIT");
			return trace;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
