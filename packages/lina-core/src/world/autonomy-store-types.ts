import type { AgentProfile } from "../agents/types.ts";
import type {
	LifeLease,
	LifeModelReconciliation,
	LifeModelRecord,
	LifeRunStatus,
	LifeSchedule,
	LifeStep,
	PreparedLifeModelRequest,
} from "./autonomy-types.ts";
import type { IdentityPolicySnapshot, LifeReceipt } from "./life-types.ts";

export interface LifePrepareRequest {
	resolvedModels?: import("./model-selection.ts").LifeResolvedModels;
	worldId: string;
	idempotencyKey: string;
	expectedConfigRevision: number;
	owner: string;
	nowMs: number;
	leaseMs: number;
	identity: IdentityPolicySnapshot;
	profiles: AgentProfile[];
	modelSettingsRevision: number;
}
export type LifeStepFailure =
	| "invalid_model_output"
	| "model_unknown"
	| "budget"
	| "cancelled"
	| "stale"
	| "engine_error"
	| "unavailable";
export interface WorldAutonomyPort {
	acquireLifeLease(
		worldId: string,
		expectedConfigRevision: number,
		owner: string,
		nowMs: number,
		leaseMs: number,
	): LifeLease;
	lifeStatus(worldId: string, nowMs: number): LifeRunStatus;
	/** Trusted fleet source change, independent of an expired or cancelled execution lease. */
	invalidateLifeIdentity(
		worldId: string,
		current: Pick<
			LifePrepareRequest,
			"identity" | "profiles" | "modelSettingsRevision"
		>,
		nowMs: number,
	): void;
	prepareLifeStep(request: LifePrepareRequest, entropy: () => number): LifeStep;
	lifeStep(worldId: string, stepId: string): LifeStep;
	renewLifeLease(lease: LifeLease, nowMs: number, leaseMs: number): LifeLease;
	releaseLifeLease(lease: LifeLease, nowMs: number): void;
	prepareLifeModel(
		lease: LifeLease,
		stepId: string,
		prepared: PreparedLifeModelRequest,
		nowMs: number,
	): LifeModelRecord;
	dispatchLifeModel(
		lease: LifeLease,
		stepId: string,
		requestId: string,
		nowMs: number,
	): { record: LifeModelRecord; dispatched: boolean };
	finishLifeModel(
		worldId: string,
		stepId: string,
		requestId: string,
		result: LifeModelReconciliation,
		nowMs: number,
	): LifeModelRecord;
	/** Decode only the saved completed actor/target response, never caller-supplied success. */
	recordLifeIntention(
		lease: LifeLease,
		stepId: string,
		nowMs: number,
	): LifeStep;
	recordLifeTarget(lease: LifeLease, stepId: string, nowMs: number): LifeStep;
	prepareLifeObservations(
		lease: LifeLease,
		stepId: string,
		socialRequestId: string | null,
		nowMs: number,
	): LifeStep;
	finishLifeStep(lease: LifeLease, stepId: string, nowMs: number): LifeStep;
	acceptLifeStep(
		lease: LifeLease,
		stepId: string,
		current: {
			identity: IdentityPolicySnapshot;
			modelSettingsRevision: number;
		},
		nowMs: number,
	): LifeReceipt;
	failLifeStep(
		lease: LifeLease,
		stepId: string,
		reason: LifeStepFailure,
		nowMs: number,
	): LifeStep;
	advanceLifeSchedule(
		lease: LifeLease,
		nowMs: number,
		nextDue: number,
		skippedIntervals: number,
	): LifeSchedule;
}
