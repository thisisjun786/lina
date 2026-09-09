import type { TaskManager } from "../../../lina-codex/src/tasks.ts";
import type { WorkEvidenceSnapshot } from "../../../lina-core/src/world/work-types.ts";
import { LifeExecutionError } from "./actor.ts";

/** A delayed/failed restriction delivery cannot extend source-side sharing authority. */
export function assertWorkSourceCurrent(
	source:
		| Pick<TaskManager, "workDeliveryCurrent" | "workProofCurrent">
		| undefined,
	snapshot: WorkEvidenceSnapshot | undefined,
) {
	if (!snapshot) return;
	for (const { source: record } of snapshot.records) {
		if (record.kind === "resource_activity")
			throw new LifeExecutionError(
				"stale",
				"Resource activity source owner is not connected",
			);
		if (
			!source?.workDeliveryCurrent(record.deliveryId, record.sourceDigest) ||
			(record.operation === "upsert" &&
				!source.workProofCurrent({
					taskId: record.receipt.taskId,
					receiptId: record.receipt.receiptId,
					receiptRevision: record.receipt.receiptRevision,
					policyRevision: record.policyRevision,
					worldId: snapshot.worldId,
					payloadDigest: record.sourceDigest,
				}))
		)
			throw new LifeExecutionError("stale", "Work source authority changed");
	}
}
