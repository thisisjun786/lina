import type { DatabaseSync } from "node:sqlite";
import { resolveWorkAttribution } from "./task-work-attribution.ts";
import { auditWorkDecisions, decisionKey } from "./task-work-decision-audit.ts";
import { projectWorkDelivery } from "./task-work-outbox.ts";
import type { TaskWorkStore } from "./task-work-store.ts";
import {
	nativeWorkStatus,
	parseWorkReceipt,
	parseWorkSharingDecision,
	workDigest,
	workId,
	workRevision,
} from "./task-work-validation.ts";
import { field, REQUEST_MAX } from "./tasks/validate.ts";

/** Strict restore checks the immutable chain and relational payloads before commit. */
export function auditTaskWork(db: DatabaseSync, work: TaskWorkStore): void {
	const decisions = auditWorkDecisions(db, work);
	for (const r of db.prepare("SELECT * FROM task_work_inputs").all()) {
		field(r["request_id"], "requestId", REQUEST_MAX);
		workId(r["task_id"]);
		workId(r["owner_agent_id"]);
		workRevision(r["task_revision"], 0);
		if (r["turn_id"] !== null) workId(r["turn_id"]);
		if (r["target_turn_id"] !== null) workId(r["target_turn_id"]);
		const prior: unknown = JSON.parse(String(r["prior_turn_ids_json"]));
		if (!Array.isArray(prior) || new Set(prior).size !== prior.length)
			throw Error("Invalid work dispatch history");
		prior.forEach(workId);
		if (
			(r["rejected"] !== 0 && r["rejected"] !== 1) ||
			(r["rejected"] === 1 && r["turn_id"] !== null)
		)
			throw Error("Invalid work rejected input");
		if (
			r["turn_id"] !== null &&
			((r["target_turn_id"] !== null && r["target_turn_id"] !== r["turn_id"]) ||
				(r["target_turn_id"] === null && prior.includes(r["turn_id"])))
		)
			throw Error("Invalid work dispatch target");

		const request = db
			.prepare("SELECT task_id FROM task_requests WHERE request_id=?")
			.get(String(r["request_id"]));
		if (request?.["task_id"] !== r["task_id"])
			throw new Error("work input source mismatch");
	}
	for (const r of db.prepare("SELECT * FROM task_work_handovers").all()) {
		workId(r["task_id"]);
		workId(r["from_owner"]);
		workId(r["to_owner"]);
		workRevision(r["task_revision"]);
		if (r["turn_id"] !== null) workId(r["turn_id"]);
	}
	for (const o of db.prepare("SELECT * FROM task_work_observations").all()) {
		const id = workId(o["receipt_id"]);
		if (
			id !== workDigest([workId(o["task_id"]), workId(o["turn_id"])]) ||
			nativeWorkStatus(o["native_status"]) === null
		)
			throw new Error("invalid work observation identity");
		const attribution = resolveWorkAttribution(db, o);
		const hasBaseline =
			db
				.prepare(
					"SELECT 1 FROM task_work_receipts WHERE receipt_id=? AND receipt_revision=1",
				)
				.get(id) !== undefined;
		if (attribution === null) {
			if (hasBaseline)
				throw new Error(
					"work attribution is unresolved for a published receipt",
				);
			if (
				db
					.prepare("SELECT 1 FROM task_work_policies WHERE receipt_id=?")
					.get(id) ||
				db
					.prepare("SELECT 1 FROM task_work_receipts WHERE receipt_id=?")
					.get(id)
			)
				throw new Error(
					"pending work attribution cannot have revisions or policy",
				);
			continue;
		}
		const baseline = work.receipt(id, 1);
		if (
			baseline.taskRevision !== o["task_revision"] ||
			baseline.ownerAgentId !== attribution.ownerAgentId ||
			baseline.attributionStatus !== attribution.attributionStatus ||
			workDigest(baseline.participantAgentIds) !==
				workDigest(attribution.participantAgentIds)
		)
			throw new Error("work baseline attribution source mismatch");
		if (
			baseline.taskId !== o["task_id"] ||
			baseline.turnId !== o["turn_id"] ||
			id !== workDigest([baseline.taskId, baseline.turnId]) ||
			baseline.outcome !==
				(o["native_status"] === "completed" ? "turn_ended" : o["native_status"])
		)
			throw new Error("work observation source mismatch");
		let revision = 0;
		for (const row of db
			.prepare(
				"SELECT * FROM task_work_receipts WHERE receipt_id=? ORDER BY receipt_revision",
			)
			.all(id)) {
			const r = parseWorkReceipt(JSON.parse(String(row["receipt_json"])));
			if (
				r.id !== id ||
				r.receiptRevision !== ++revision ||
				row["receipt_revision"] !== revision ||
				r.taskId !== baseline.taskId ||
				r.turnId !== baseline.turnId ||
				r.taskRevision !== baseline.taskRevision ||
				r.ownerAgentId !== baseline.ownerAgentId ||
				r.attributionStatus !== baseline.attributionStatus ||
				workDigest(r.participantAgentIds) !==
					workDigest(baseline.participantAgentIds) ||
				(r.outcome === "verified_result"
					? baseline.outcome !== "turn_ended"
					: r.outcome !== baseline.outcome)
			)
				throw new Error("invalid immutable work receipt chain");
			if (
				revision > 1 &&
				r.correction === null &&
				r.outcome !== "verified_result"
			)
				throw new Error("missing work revision decision");
			if (revision > 1 && !decisions.has(decisionKey("receipt", id, revision)))
				throw new Error("missing work receipt decision");
		}
		let policyRevision = 0;
		for (const row of db
			.prepare(
				"SELECT * FROM task_work_policies WHERE receipt_id=? ORDER BY policy_revision",
			)
			.all(id)) {
			const p = parseWorkSharingDecision(
				JSON.parse(String(row["policy_json"])),
			);
			if (
				p.receiptId !== id ||
				p.taskId !== baseline.taskId ||
				p.policyRevision !== ++policyRevision ||
				row["policy_revision"] !== policyRevision
			)
				throw new Error("invalid work policy chain");
			if (!decisions.has(decisionKey("policy", id, policyRevision)))
				throw new Error("missing work policy decision");
		}
	}
	for (const d of work.outbox.all()) {
		const receipt = work.receipt(d.receipt.id, d.receipt.receiptRevision);
		const row = db
			.prepare(
				"SELECT policy_json FROM task_work_policies WHERE receipt_id=? AND policy_revision=?",
			)
			.get(receipt.id, d.policyRevision);
		if (!row || workDigest(receipt) !== workDigest(d.receipt))
			throw new Error("orphan work delivery source");
		const policy = parseWorkSharingDecision(
			JSON.parse(String(row["policy_json"])),
		);
		if (
			workDigest(projectWorkDelivery(receipt, policy, d.worldId)) !==
			d.payloadDigest
		)
			throw new Error("work delivery policy mismatch");
		const attempts = work.outbox.attempts(d.deliveryId);
		const last = attempts.at(-1);
		if (
			last
				? last.status !== d.status || last.reason !== d.reason
				: d.status !== "pending" || d.reason !== null
		)
			throw new Error("work delivery attempt mismatch");
	}
}
