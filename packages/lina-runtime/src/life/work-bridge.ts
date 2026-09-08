import { parseWorkDeliveryPayload } from "../../../lina-codex/src/task-work-outbox.ts";
import type { WorkDelivery } from "../../../lina-codex/src/task-work-types.ts";
import {
	workDigest,
	workProof,
} from "../../../lina-codex/src/task-work-validation.ts";
import type { TaskManager } from "../../../lina-codex/src/tasks.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { LifeInputV2 } from "../../../lina-core/src/world/life-types.ts";
import { parseLifeInput } from "../../../lina-core/src/world/life-validation.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { WorkInputSource } from "../../../lina-core/src/world/work-types.ts";

export type WorkBridgeSource = Pick<
	TaskManager,
	| "subscribeWork"
	| "pendingWorkDeliveries"
	| "workDeliveryCurrent"
	| "workProofCurrent"
	| "recordWorkDeliveryAttempt"
	| "acknowledgeWorkDelivery"
>;
export type WorkBridgeWorld = Pick<
	WorldStore,
	"lifeConfig" | "admitWorkInput" | "workEvidence"
>;
export interface WorkBridgeOptions {
	source: WorkBridgeSource;
	/** Includes retained worlds, even when no longer selected for new exports. */
	world: WorkBridgeWorld;
	onError(error: unknown, deliveryId?: string): void;
}
export interface WorkBridgePoll {
	delivered: number;
	replayed: number;
	withheld: number;
	failed: number;
}

/** Private provenance is separate from the explicitly permitted model fields. */
function inputFor(delivery: WorkDelivery): LifeInputV2 {
	const { status: _status, reason: _reason, payloadDigest, ...raw } = delivery;
	const payload = parseWorkDeliveryPayload(raw);
	if (workDigest(payload) !== payloadDigest)
		throw Error("Work payload digest mismatch");
	const r = payload.receipt;
	const source: WorkInputSource = {
		kind: "work",
		deliveryId: payload.deliveryId,
		operation: payload.operation,
		sourceDigest: payloadDigest,
		policyRevision: payload.policyRevision,
		receipt: {
			receiptId: r.id,
			receiptRevision: r.receiptRevision,
			supersedesRevision: r.supersedesRevision,
			taskId: r.taskId,
			turnId: r.turnId,
			taskRevision: r.taskRevision,
			ownerAgentId: r.ownerAgentId,
			participantAgentIds: r.participantAgentIds,
			attributionStatus: r.attributionStatus,
			outcome: r.outcome,
			correction: r.correction,
			evidenceDigest: lifeDigest(r.evidenceRefs),
		},
		fields: payload.fields,
	};
	const input = parseLifeInput({
		version: 2,
		worldId: payload.worldId,
		id: payload.deliveryId,
		sourceRevision: r.receiptRevision,
		source,
		payloadDigest: lifeDigest(source),
		consumedLifeRevision: null,
	});
	if (input.version !== 2) throw Error("Invalid work input version");
	return input;
}

/** Synchronous store ports keep final proof checks adjacent to commit and acknowledgement. */
export function createWorkBridge({
	source,
	world,
	onError,
}: WorkBridgeOptions) {
	let unsubscribe: (() => void) | undefined;
	let closed = false;
	let polling = false;
	let wake = false;
	function current(delivery: WorkDelivery): boolean {
		return (
			source.workDeliveryCurrent(delivery.deliveryId, delivery.payloadDigest) &&
			(delivery.operation === "restrict" ||
				source.workProofCurrent(workProof(delivery)))
		);
	}
	function destination(delivery: WorkDelivery): string | null {
		try {
			world.workEvidence(delivery.worldId);
			if (delivery.operation === "restrict") return null;
			const config = world.lifeConfig(delivery.worldId);
			if (config.version !== 2 || !config.work) return "work_not_configured";
			if (
				!config.work.rules.some(
					(rule) => rule.categoryId === delivery.fields?.categoryId,
				)
			)
				return "work_category_not_configured";
			return null;
		} catch {
			return "work_world_unavailable";
		}
	}
	function withhold(
		delivery: WorkDelivery,
		reason: string,
		result: WorkBridgePoll,
	) {
		source.recordWorkDeliveryAttempt(
			delivery.deliveryId,
			delivery.payloadDigest,
			"withheld",
			reason,
		);
		result.withheld++;
	}
	function deliver(delivery: WorkDelivery, result: WorkBridgePoll) {
		try {
			const input = inputFor(delivery);
			const reason = destination(delivery);
			if (reason) return withhold(delivery, reason, result);
			if (!current(delivery))
				return withhold(delivery, "work_source_changed", result);
			const receipt = world.admitWorkInput(input);
			if (
				receipt.worldId !== input.worldId ||
				receipt.inputId !== input.id ||
				receipt.payloadDigest !== input.payloadDigest
			)
				throw Error("Work admission receipt mismatch");
			const after = destination(delivery);
			if (after) return withhold(delivery, after, result);
			if (!current(delivery))
				return withhold(delivery, "work_source_changed", result);
			source.acknowledgeWorkDelivery(
				delivery.deliveryId,
				delivery.payloadDigest,
			);
			result.delivered++;
			if (receipt.replayed) result.replayed++;
		} catch (error) {
			result.failed++;
			try {
				source.recordWorkDeliveryAttempt(
					delivery.deliveryId,
					delivery.payloadDigest,
					"failed",
					"work_delivery_failed",
				);
			} catch (recordError) {
				onError(recordError, delivery.deliveryId);
			}
			onError(error, delivery.deliveryId);
		}
	}
	function poll(): WorkBridgePoll {
		if (closed) throw Error("Work bridge is closed");
		const result: WorkBridgePoll = {
			delivered: 0,
			replayed: 0,
			withheld: 0,
			failed: 0,
		};
		wake = true;
		if (polling) return result;
		polling = true;
		try {
			while (wake) {
				wake = false;
				// Failed/withheld rows remain visible, but only an explicit source retry reactivates them.
				for (const delivery of source.pendingWorkDeliveries()) {
					if (delivery.status === "pending") deliver(delivery, result);
				}
			}
		} finally {
			polling = false;
		}
		return result;
	}
	return {
		/** Subscribe before startup drain. Call again after source restore, or explicitly poll. */
		start() {
			if (closed) throw Error("Work bridge is closed");
			unsubscribe ??= source.subscribeWork(() => {
				try {
					poll();
				} catch (error) {
					onError(error);
				}
			});
			return poll();
		},
		/** Caller invokes before preparing a LIFE step; no implicit timer or retry cadence. */
		poll,
		close() {
			closed = true;
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
}
