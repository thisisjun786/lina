import type { DatabaseSync } from "node:sqlite";
import { TaskError } from "./task-types.ts";
import type {
	WorkDelivery,
	WorkDeliveryAttempt,
	WorkDeliveryPayload,
	WorkProof,
	WorkReceipt,
	WorkSharingDecision,
} from "./task-work-types.ts";
import {
	parseWorkReceipt,
	workDeliveryId,
	workDigest,
	workId,
	workObject,
	workRevision,
	workText,
} from "./task-work-validation.ts";

export function projectWorkDelivery(
	receipt: WorkReceipt,
	policy: WorkSharingDecision,
	worldId: string,
): WorkDeliveryPayload {
	const selection = policy.selection;
	const allowed =
		selection?.worldIds.includes(worldId) &&
		receipt.correction?.kind !== "retract";
	const operation = allowed ? "upsert" : "restrict";
	return {
		version: 1,
		deliveryId: workDeliveryId(
			receipt.id,
			receipt.receiptRevision,
			policy.policyRevision,
			worldId,
			operation,
		),
		worldId,
		operation,
		receipt,
		policyRevision: policy.policyRevision,
		fields:
			allowed && selection
				? {
						categoryId: selection.categoryId,
						outcome: selection.shareOutcome ? receipt.outcome : null,
						participantAgentIds: selection.shareParticipants
							? [...receipt.participantAgentIds]
							: null,
						summary: selection.summary,
					}
				: null,
	};
}
export function parseWorkDeliveryPayload(value: unknown): WorkDeliveryPayload {
	const r = workObject(value, [
		"version",
		"deliveryId",
		"worldId",
		"operation",
		"receipt",
		"policyRevision",
		"fields",
	]);
	if (
		r["version"] !== 1 ||
		(r["operation"] !== "upsert" && r["operation"] !== "restrict")
	)
		throw new Error("invalid work delivery");
	const receipt = parseWorkReceipt(r["receipt"]);
	const policyRevision = workRevision(r["policyRevision"]);
	const worldId = workId(r["worldId"]);
	let fields: WorkDeliveryPayload["fields"] = null;
	if (r["fields"] !== null) {
		const f = workObject(r["fields"], [
			"categoryId",
			"outcome",
			"participantAgentIds",
			"summary",
		]);
		if (f["outcome"] !== null && f["outcome"] !== receipt.outcome)
			throw new Error("invalid work outcome projection");
		if (
			f["participantAgentIds"] !== null &&
			workDigest(f["participantAgentIds"]) !==
				workDigest(receipt.participantAgentIds)
		)
			throw new Error("invalid work participants projection");
		fields = {
			categoryId: workId(f["categoryId"]),
			outcome: f["outcome"] as WorkDeliveryPayload["receipt"]["outcome"] | null,
			participantAgentIds:
				f["participantAgentIds"] === null
					? null
					: [...receipt.participantAgentIds],
			summary: f["summary"] === null ? null : workText(f["summary"]),
		};
	}
	if (
		(r["operation"] === "restrict") !== (fields === null) ||
		(r["operation"] === "upsert" && receipt.correction?.kind === "retract")
	)
		throw new Error("invalid restricted work delivery");
	const deliveryId = workDeliveryId(
		receipt.id,
		receipt.receiptRevision,
		policyRevision,
		worldId,
		r["operation"],
	);
	if (r["deliveryId"] !== deliveryId)
		throw new Error("invalid work delivery identity");
	return {
		version: 1,
		deliveryId,
		worldId,
		operation: r["operation"],
		receipt,
		policyRevision,
		fields,
	};
}
export class TaskWorkOutbox {
	constructor(
		private readonly db: DatabaseSync,
		private readonly current: (receiptId: string) => {
			receipt: WorkReceipt;
			policy: WorkSharingDecision;
		},
	) {}
	publish(receipt: WorkReceipt, policy: WorkSharingDecision): void {
		const worlds = new Set(
			this.db
				.prepare(
					"SELECT DISTINCT world_id FROM task_work_deliveries WHERE receipt_id=?",
				)
				.all(receipt.id)
				.map((r) => String(r["world_id"])),
		);
		for (const id of policy.selection?.worldIds ?? []) worlds.add(id);
		for (const old of this.all().filter(
			(d) =>
				d.receipt.id === receipt.id &&
				d.status !== "delivered" &&
				d.status !== "withheld",
		))
			this.attempt(
				old.deliveryId,
				"withheld",
				"superseded by current work revision",
			);
		for (const worldId of [...worlds].sort()) {
			const payload = projectWorkDelivery(receipt, policy, worldId);
			this.db
				.prepare(
					"INSERT INTO task_work_deliveries VALUES (?,?,?,?,?,'pending',NULL)",
				)
				.run(
					payload.deliveryId,
					receipt.id,
					worldId,
					JSON.stringify(payload),
					workDigest(payload),
				);
		}
	}
	all(): WorkDelivery[] {
		return this.db
			.prepare("SELECT * FROM task_work_deliveries ORDER BY rowid")
			.all()
			.map((row) => {
				const payload = parseWorkDeliveryPayload(
					JSON.parse(String(row["payload_json"])),
				);
				if (
					row["delivery_id"] !== payload.deliveryId ||
					row["receipt_id"] !== payload.receipt.id ||
					row["world_id"] !== payload.worldId ||
					row["payload_digest"] !== workDigest(payload)
				)
					throw new Error("corrupt work delivery");
				const status = row["status"];
				const reason = row["reason"];
				if (
					status !== "pending" &&
					status !== "delivered" &&
					status !== "failed" &&
					status !== "withheld"
				)
					throw new Error("invalid work delivery status");
				if (reason !== null && typeof reason !== "string")
					throw new Error("invalid delivery reason");
				if ((status === "failed" || status === "withheld") && !reason)
					throw new Error("missing delivery reason");
				return {
					...payload,
					payloadDigest: workDigest(payload),
					status,
					reason,
				};
			});
	}
	pending(): WorkDelivery[] {
		return this.all().filter(
			(d) => d.status !== "delivered" && this.currentPayload(d),
		);
	}
	require(deliveryId: string, payloadDigest: string): WorkDelivery {
		const d = this.all().find((d) => d.deliveryId === workId(deliveryId));
		if (!d || d.payloadDigest !== payloadDigest)
			throw new TaskError(
				"conflict",
				"work delivery identity or digest conflict",
			);
		return d;
	}
	currentPayload(delivery: WorkDelivery): boolean {
		const { receipt, policy } = this.current(delivery.receipt.id);
		return (
			workDigest(projectWorkDelivery(receipt, policy, delivery.worldId)) ===
			delivery.payloadDigest
		);
	}
	proofCurrent(proof: WorkProof): boolean {
		try {
			const p = workObject(proof, [
				"taskId",
				"receiptId",
				"receiptRevision",
				"policyRevision",
				"worldId",
				"payloadDigest",
			]);
			const { receipt, policy } = this.current(workId(p["receiptId"]));
			if (
				receipt.taskId !== p["taskId"] ||
				receipt.receiptRevision !== p["receiptRevision"] ||
				policy.policyRevision !== p["policyRevision"]
			)
				return false;
			const payload = projectWorkDelivery(
				receipt,
				policy,
				workId(p["worldId"]),
			);
			return (
				payload.operation === "upsert" &&
				workDigest(payload) === p["payloadDigest"] &&
				this.all().some((d) => d.deliveryId === payload.deliveryId)
			);
		} catch {
			return false;
		}
	}
	acknowledge(deliveryId: string, payloadDigest: string): void {
		const d = this.require(deliveryId, payloadDigest);
		if (d.status === "delivered") return;
		if (d.status !== "pending" || !this.currentPayload(d))
			throw new TaskError(
				"conflict",
				"withheld, failed or stale work delivery cannot be acknowledged",
			);
		this.attempt(deliveryId, "delivered", null);
	}
	recordAttempt(
		deliveryId: string,
		payloadDigest: string,
		status: "failed" | "withheld",
		reason: string,
	): void {
		const d = this.require(deliveryId, payloadDigest);
		workText(reason);
		if (status !== "failed" && status !== "withheld")
			throw new TaskError("invalid_input", "invalid delivery failure status");
		if (d.status === "delivered")
			throw new TaskError("conflict", "delivery already acknowledged");
		this.attempt(deliveryId, status, reason);
	}
	retry(deliveryId: string, payloadDigest: string): void {
		const d = this.require(deliveryId, payloadDigest);
		if (d.status === "delivered" || d.status === "pending") return;
		if (!this.currentPayload(d))
			throw new TaskError("conflict", "stale work delivery cannot be retried");
		this.attempt(deliveryId, "pending", null);
	}
	attempts(deliveryId: string): WorkDeliveryAttempt[] {
		return this.db
			.prepare(
				"SELECT sequence,delivery_id,status,reason FROM task_work_delivery_attempts WHERE delivery_id=? ORDER BY sequence",
			)
			.all(workId(deliveryId))
			.map((r) => ({
				sequence: workRevision(r["sequence"]),
				deliveryId: String(r["delivery_id"]),
				status: r["status"] as WorkDeliveryAttempt["status"],
				reason: r["reason"] as string | null,
			}));
	}
	private attempt(
		deliveryId: string,
		status: WorkDelivery["status"],
		reason: string | null,
	): void {
		this.db
			.prepare(
				"UPDATE task_work_deliveries SET status=?,reason=? WHERE delivery_id=?",
			)
			.run(status, reason, deliveryId);
		this.db
			.prepare(
				"INSERT INTO task_work_delivery_attempts(delivery_id,status,reason) VALUES (?,?,?)",
			)
			.run(deliveryId, status, reason);
	}
}
