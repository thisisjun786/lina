import type { DatabaseSync } from "node:sqlite";
import type { StoredTask } from "./task-store.ts";
import { TaskError, type TaskThread } from "./task-types.ts";
import {
	captureWorkAttribution,
	resolveWorkAttribution,
} from "./task-work-attribution.ts";
import { authorizeWork } from "./task-work-authority.ts";
import { TaskWorkOutbox } from "./task-work-outbox.ts";
import type {
	ConfirmWorkInput,
	CorrectWorkInput,
	ShareWorkInput,
	WorkAuthority,
	WorkChange,
	WorkReceipt,
	WorkSharingDecision,
} from "./task-work-types.ts";
import {
	nativeWorkStatus,
	parseConfirmWorkInput,
	parseCorrectWorkInput,
	parseShareWorkInput,
	parseWorkReceipt,
	parseWorkSharingDecision,
	workDigest,
	workId,
} from "./task-work-validation.ts";

/** Lives in TaskStore's database and transaction; never imports a world or issues RPC. */
export class TaskWorkStore {
	readonly outbox: TaskWorkOutbox;
	constructor(
		private readonly db: DatabaseSync,
		private readonly task: (id: string) => StoredTask,
		private readonly changed: (change: WorkChange) => void,
	) {
		this.outbox = new TaskWorkOutbox(db, (id) => {
			const receipt = this.currentReceipt(id);
			return { receipt, policy: this.sharing(receipt.taskId, id) };
		});
	}
	recordInput(task: StoredTask, requestId: string): void {
		this.db
			.prepare("INSERT INTO task_work_inputs VALUES (?,?,NULL,?,?,?,?,0)")
			.run(
				requestId,
				task.id,
				task.ownerAgentId,
				task.revision,
				["running", "waiting_approval", "waiting_input"].includes(task.status)
					? task.lastTurnId
					: null,
				JSON.stringify(task.knownTurnIds),
			);
	}

	rejectInput(taskId: string, requestId: string): void {
		const row = this.db
			.prepare(
				"SELECT task_id,turn_id FROM task_work_inputs WHERE request_id=?",
			)
			.get(requestId);
		if (!row || row["task_id"] !== taskId || row["turn_id"] !== null)
			throw Error("Conflicting work rejection");
		this.db
			.prepare("UPDATE task_work_inputs SET rejected=1 WHERE request_id=?")
			.run(requestId);
		this.finalizePending(taskId);
	}
	bindInput(taskId: string, requestId: string, turnId: string): void {
		workId(turnId);
		const row = this.db
			.prepare(
				"SELECT task_id,turn_id,target_turn_id,prior_turn_ids_json,rejected FROM task_work_inputs WHERE request_id=?",
			)
			.get(requestId);
		if (!row) return; // v1 has no reconstructible management-at-dispatch proof.
		if (
			row["task_id"] !== taskId ||
			(row["turn_id"] !== null && row["turn_id"] !== turnId) ||
			row["rejected"] !== 0 ||
			(row["target_turn_id"] !== null && row["target_turn_id"] !== turnId) ||
			(JSON.parse(String(row["prior_turn_ids_json"])).includes(turnId) &&
				row["target_turn_id"] !== turnId)
		)
			throw new TaskError("conflict", "managed input turn identity conflict");
		this.db
			.prepare("UPDATE task_work_inputs SET turn_id=? WHERE request_id=?")
			.run(turnId, requestId);
		this.finalizePending(taskId);
	}
	handover(before: StoredTask, after: StoredTask): void {
		const turnId = ["running", "waiting_approval", "waiting_input"].includes(
			before.status,
		)
			? before.lastTurnId
			: null;
		this.db
			.prepare("INSERT INTO task_work_handovers VALUES (?,?,?,?,?)")
			.run(
				before.id,
				after.revision,
				before.ownerAgentId,
				after.ownerAgentId,
				turnId,
			);
	}
	reconcile(taskId: string, thread: TaskThread): void {
		for (const turn of thread.turns)
			for (const item of turn.items) {
				if (
					!item ||
					typeof item !== "object" ||
					!("type" in item) ||
					item.type !== "userMessage" ||
					!("clientId" in item) ||
					typeof item.clientId !== "string"
				)
					continue;
				this.bindInput(taskId, item.clientId, turn.id);
			}
		for (const turn of thread.turns)
			this.observeWorkTurn(taskId, turn.id, turn.status);
		this.finalizePending(taskId);
	}
	hasPendingAttribution(taskId: string): boolean {
		return (
			this.db
				.prepare(
					"SELECT 1 FROM task_work_observations o WHERE o.task_id=? AND NOT EXISTS (SELECT 1 FROM task_work_receipts r WHERE r.receipt_id=o.receipt_id) LIMIT 1",
				)
				.get(taskId) !== undefined
		);
	}
	/** Internal native transaction only; no TaskManager/HTTP/model operation exposes it. */
	observeWorkTurn(
		taskId: string,
		turnId: string,
		status: unknown,
	): WorkReceipt | null {
		const native = nativeWorkStatus(status);
		if (!native) return null;
		workId(turnId);
		let observation = this.db
			.prepare(
				"SELECT * FROM task_work_observations WHERE task_id=? AND turn_id=?",
			)
			.get(taskId, turnId);
		if (observation) {
			if (observation["native_status"] !== native)
				throw new TaskError("conflict", "native terminal outcome changed");
		} else {
			const task = this.task(taskId);
			const id = workDigest([taskId, turnId]);
			const sources = captureWorkAttribution(this.db, taskId, turnId);
			this.db
				.prepare("INSERT INTO task_work_observations VALUES (?,?,?,?,?,?)")
				.run(
					id,
					taskId,
					turnId,
					native,
					task.revision,
					JSON.stringify(sources),
				);
			observation = this.db
				.prepare("SELECT * FROM task_work_observations WHERE receipt_id=?")
				.get(id);
		}
		if (!observation) throw new Error("work observation persist failed");
		return this.finalizeObservation(observation);
	}
	private finalizePending(taskId: string): void {
		for (const row of this.db
			.prepare(
				"SELECT o.* FROM task_work_observations o WHERE o.task_id=? AND NOT EXISTS (SELECT 1 FROM task_work_receipts r WHERE r.receipt_id=o.receipt_id) ORDER BY o.rowid",
			)
			.all(taskId))
			this.finalizeObservation(row);
	}
	private finalizeObservation(
		observation: Record<string, unknown>,
	): WorkReceipt | null {
		const id = String(observation["receipt_id"]);
		if (
			this.db
				.prepare(
					"SELECT 1 FROM task_work_receipts WHERE receipt_id=? AND receipt_revision=1",
				)
				.get(id)
		)
			return this.receipt(id, 1);
		const attribution = resolveWorkAttribution(this.db, observation);
		if (attribution === null) return null;
		const native = observation["native_status"];
		const receipt = parseWorkReceipt({
			version: 1,
			id,
			taskId: observation["task_id"],
			turnId: observation["turn_id"],
			taskRevision: observation["task_revision"],
			receiptRevision: 1,
			...attribution,
			outcome: native === "completed" ? "turn_ended" : native,
			supersedesRevision: null,
			correction: null,
			evidenceRefs: [],
		});
		this.insertReceipt(receipt);
		return receipt;
	}

	receipts(taskId: string): WorkReceipt[] {
		this.task(workId(taskId));
		return this.db
			.prepare(
				"SELECT r.receipt_json FROM task_work_receipts r JOIN task_work_observations o ON o.receipt_id=r.receipt_id WHERE o.task_id=? ORDER BY r.rowid",
			)
			.all(taskId)
			.map((r) => parseWorkReceipt(JSON.parse(String(r["receipt_json"]))));
	}
	receipt(receiptId: string, revision: number): WorkReceipt {
		const row = this.db
			.prepare(
				"SELECT receipt_json FROM task_work_receipts WHERE receipt_id=? AND receipt_revision=?",
			)
			.get(receiptId, revision);
		if (!row)
			throw new TaskError("invalid_input", "unknown work receipt revision");
		return parseWorkReceipt(JSON.parse(String(row["receipt_json"])));
	}
	currentReceipt(receiptId: string): WorkReceipt {
		const row = this.db
			.prepare(
				"SELECT receipt_json FROM task_work_receipts WHERE receipt_id=? ORDER BY receipt_revision DESC LIMIT 1",
			)
			.get(workId(receiptId));
		if (!row) throw new TaskError("invalid_input", "unknown work receipt");
		return parseWorkReceipt(JSON.parse(String(row["receipt_json"])));
	}
	sharing(taskId: string, receiptId: string): WorkSharingDecision {
		this.ownedReceipt(taskId, receiptId);
		const row = this.db
			.prepare(
				"SELECT policy_json FROM task_work_policies WHERE receipt_id=? ORDER BY policy_revision DESC LIMIT 1",
			)
			.get(receiptId);
		return row
			? parseWorkSharingDecision(JSON.parse(String(row["policy_json"])))
			: { version: 1, taskId, receiptId, policyRevision: 0, selection: null };
	}
	confirm(
		taskId: string,
		value: ConfirmWorkInput,
		authority: WorkAuthority,
	): WorkReceipt {
		const input = parseConfirmWorkInput(value);
		const task = this.task(workId(taskId));
		const current = this.ownedReceipt(taskId, input.receiptId);
		const checked = this.receipt(
			input.receiptId,
			input.expectedReceiptRevision,
		);
		const auth = authorizeWork(authority, task.ownerAgentId, "confirm", {
			taskId,
			currentOwnerAgentId: task.ownerAgentId,
			receipt: checked,
			evidenceRef: input.evidenceRef,
		});
		const digest = workDigest([taskId, "confirm", input, auth.identity]);
		const prior = this.replay(input.requestId, digest);
		if (prior) return parseWorkReceipt(prior);
		this.expected(current.receiptRevision, input.expectedReceiptRevision);
		const baseline = this.receipt(input.receiptId, 1);
		if (baseline.outcome !== "turn_ended")
			throw new TaskError(
				"invalid_input",
				"verification requires an explicitly observed completed turn",
			);
		const next: WorkReceipt = {
			...baseline,
			receiptRevision: current.receiptRevision + 1,
			supersedesRevision: current.receiptRevision,
			correction: null,
			outcome: "verified_result",
			evidenceRefs: [
				{
					kind: auth.kind,
					authorityId: auth.authorityId,
					reference: input.evidenceRef,
					receiptRevision: current.receiptRevision,
				},
			],
		};
		this.insertReceipt(next);
		this.saveOperation(taskId, "confirm", input, auth.identity, next);
		this.outbox.publish(next, this.sharing(taskId, input.receiptId));
		return next;
	}
	correct(
		taskId: string,
		value: CorrectWorkInput,
		authority: WorkAuthority,
	): WorkReceipt {
		const input = parseCorrectWorkInput(value);
		const task = this.task(workId(taskId));
		const current = this.ownedReceipt(taskId, input.receiptId);
		const auth = authorizeWork(authority, task.ownerAgentId, "correct");
		const digest = workDigest([taskId, "correct", input, auth.identity]);
		const prior = this.replay(input.requestId, digest);
		if (prior) return parseWorkReceipt(prior);
		this.expected(current.receiptRevision, input.expectedReceiptRevision);
		const next: WorkReceipt = {
			...this.receipt(input.receiptId, 1),
			receiptRevision: current.receiptRevision + 1,
			supersedesRevision: current.receiptRevision,
			correction: { kind: input.kind, reason: input.reason },
			evidenceRefs: [],
		};
		this.insertReceipt(next);
		this.saveOperation(taskId, "correct", input, auth.identity, next);
		this.outbox.publish(next, this.sharing(taskId, input.receiptId));
		return next;
	}
	share(
		taskId: string,
		value: ShareWorkInput,
		authority: WorkAuthority,
	): WorkSharingDecision {
		const input = parseShareWorkInput(value);
		const task = this.task(workId(taskId));
		const receipt = this.ownedReceipt(taskId, input.receiptId);
		const auth = authorizeWork(authority, task.ownerAgentId, "share");
		const digest = workDigest([taskId, "share", input, auth.identity]);
		const prior = this.replay(input.requestId, digest);
		if (prior) return parseWorkSharingDecision(prior);
		const current = this.sharing(taskId, input.receiptId);
		this.expected(current.policyRevision, input.expectedPolicyRevision);
		const next = parseWorkSharingDecision({
			...current,
			policyRevision: current.policyRevision + 1,
			selection: input.selection,
		});
		this.db
			.prepare("INSERT INTO task_work_policies VALUES (?,?,?)")
			.run(receipt.id, next.policyRevision, JSON.stringify(next));
		this.saveOperation(taskId, "share", input, auth.identity, next);
		this.outbox.publish(receipt, next);
		this.changed({ taskId, receiptId: receipt.id });
		return next;
	}
	private ownedReceipt(taskId: string, receiptId: string): WorkReceipt {
		this.task(workId(taskId));
		const receipt = this.currentReceipt(receiptId);
		if (receipt.taskId !== taskId)
			throw new TaskError(
				"invalid_input",
				"work receipt does not belong to task",
			);
		return receipt;
	}
	private expected(actual: number, expected: number): void {
		if (actual !== expected)
			throw new TaskError("revision_mismatch", "work revision does not match");
	}
	private insertReceipt(value: WorkReceipt): void {
		const receipt = parseWorkReceipt(value);
		this.db
			.prepare("INSERT INTO task_work_receipts VALUES (?,?,?)")
			.run(receipt.id, receipt.receiptRevision, JSON.stringify(receipt));
		this.changed({ taskId: receipt.taskId, receiptId: receipt.id });
	}
	private replay(requestId: string, digest: string): unknown {
		const row = this.db
			.prepare(
				"SELECT digest,result_json FROM task_work_operations WHERE request_id=?",
			)
			.get(requestId);
		if (!row) return null;
		if (row["digest"] !== digest)
			throw new TaskError(
				"conflict",
				"work request key payload or authority conflict",
			);
		return JSON.parse(String(row["result_json"]));
	}
	private saveOperation(
		taskId: string,
		kind: "confirm" | "correct" | "share",
		input: ConfirmWorkInput | CorrectWorkInput | ShareWorkInput,
		authorityIdentity: string,
		result: WorkReceipt | WorkSharingDecision,
	): void {
		const operation = [taskId, kind, input, authorityIdentity];
		this.db
			.prepare("INSERT INTO task_work_operations VALUES (?,?,?,?,?,?)")
			.run(
				input.requestId,
				taskId,
				kind,
				workDigest(operation),
				JSON.stringify(operation),
				JSON.stringify(result),
			);
	}
}
