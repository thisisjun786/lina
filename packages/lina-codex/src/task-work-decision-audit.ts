import type { DatabaseSync } from "node:sqlite";
import type { TaskWorkStore } from "./task-work-store.ts";
import type { WorkReceipt, WorkSharingDecision } from "./task-work-types.ts";
import {
	parseConfirmWorkInput,
	parseCorrectWorkInput,
	parseShareWorkInput,
	parseWorkReceipt,
	parseWorkSharingDecision,
	workDigest,
	workId,
} from "./task-work-validation.ts";

export function decisionKey(
	kind: "receipt" | "policy",
	id: string,
	revision: number,
): string {
	return JSON.stringify([kind, id, revision]);
}

/** Verify stored outcomes against the exact canonical request and trusted actor identity. */
export function auditWorkDecisions(
	db: DatabaseSync,
	work: TaskWorkStore,
): Set<string> {
	const keys = new Set<string>();
	for (const row of db.prepare("SELECT * FROM task_work_operations").all()) {
		const requestId = workId(row["request_id"]);
		const taskId = workId(row["task_id"]);
		const operation: unknown = JSON.parse(String(row["operation_json"]));
		if (
			!Array.isArray(operation) ||
			operation.length !== 4 ||
			operation[0] !== taskId ||
			operation[1] !== row["kind"] ||
			typeof operation[3] !== "string" ||
			workDigest(operation) !== row["digest"]
		)
			throw new Error("work operation digest mismatch");
		const authority: unknown = JSON.parse(operation[3]);
		if (
			!Array.isArray(authority) ||
			(authority[0] === "local-management"
				? authority.length !== 3
				: authority[0] !== "verifier" || authority.length !== 2)
		)
			throw new Error("invalid work decision authority");
		for (const id of authority.slice(1)) workId(id);
		const result: unknown = JSON.parse(String(row["result_json"]));
		let expected: WorkReceipt | WorkSharingDecision;
		let key: string;
		let stored: Record<string, unknown> | undefined;
		if (operation[1] === "share") {
			const input = parseShareWorkInput(operation[2]);
			const value = parseWorkSharingDecision(result);
			if (input.requestId !== requestId || authority[0] !== "local-management")
				throw new Error("work decision identity mismatch");
			expected = {
				version: 1,
				taskId,
				receiptId: input.receiptId,
				policyRevision: input.expectedPolicyRevision + 1,
				selection: input.selection,
			};
			stored = db
				.prepare(
					"SELECT policy_json AS json FROM task_work_policies WHERE receipt_id=? AND policy_revision=?",
				)
				.get(value.receiptId, value.policyRevision);
			key = decisionKey("policy", value.receiptId, value.policyRevision);
		} else {
			const input =
				operation[1] === "confirm"
					? parseConfirmWorkInput(operation[2])
					: parseCorrectWorkInput(operation[2]);
			const value = parseWorkReceipt(result);
			if (input.requestId !== requestId)
				throw new Error("work decision identity mismatch");
			const baseline = work.receipt(input.receiptId, 1);
			if (baseline.taskId !== taskId)
				throw new Error("work decision task mismatch");
			expected = {
				...baseline,
				receiptRevision: input.expectedReceiptRevision + 1,
				supersedesRevision: input.expectedReceiptRevision,
				correction: null,
				evidenceRefs: [],
			};
			if ("evidenceRef" in input) {
				if (baseline.outcome !== "turn_ended")
					throw new Error("work decision cannot verify non-completed baseline");
				expected.outcome = "verified_result";
				expected.evidenceRefs = [
					{
						kind:
							authority[0] === "local-management"
								? "owner_confirmation"
								: "verifier",
						authorityId: workId(authority[1]),
						reference: input.evidenceRef,
						receiptRevision: input.expectedReceiptRevision,
					},
				];
			} else {
				if (authority[0] !== "local-management")
					throw new Error("work decision authority cannot correct");
				expected.correction = { kind: input.kind, reason: input.reason };
			}
			stored = db
				.prepare(
					"SELECT receipt_json AS json FROM task_work_receipts WHERE receipt_id=? AND receipt_revision=?",
				)
				.get(value.id, value.receiptRevision);
			key = decisionKey("receipt", value.id, value.receiptRevision);
		}
		if (
			workDigest(expected) !== workDigest(result) ||
			!stored ||
			workDigest(JSON.parse(String(stored["json"]))) !== workDigest(result)
		)
			throw new Error("work decision result mismatch");
		if (keys.has(key)) throw new Error("duplicate work revision decision");
		keys.add(key);
	}
	return keys;
}
