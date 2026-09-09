import type {
	ImageCountRecord,
	ImageOutputReceipt,
} from "./image-accounting-types.ts";
import type { LifeImageIntent, LifeImageSettings } from "./image-types.ts";

export interface ImageAttemptRoute {
	provider: string;
	model: string;
	settingsRevision: number;
}
export interface PrepareImageAttemptInput {
	owner: LifeImageIntent["owner"];
	intentId: string;
	briefDigest: string;
	requestKey: string;
	route: ImageAttemptRoute;
}
export interface RetryImageAttemptInput extends PrepareImageAttemptInput {
	previousAttemptId: string;
}
export interface ImageAttemptObservation {
	jobId: string;
	state:
		| "prepared"
		| "submitting"
		| "queued"
		| "running"
		| "post_processing"
		| "uncertain"
		| "cancelling"
		| "completed"
		| "failed"
		| "cancelled";
	endpoint: string | null;
	runtimeVersion: string | null;
	resultFilename: string | null;
	artifact: ImageOutputReceipt | null;
	error: string | null;
}
/** Successful destination receipts come from their actual transactional owner. */
export type ImageAttemptDelivery =
	| { kind: "pending" }
	| {
			kind: "post";
			receiptId: string;
			postId: string;
			postRevision: number;
			artifactId: string;
	  }
	| {
			kind: "avatar";
			receiptId: string;
			candidateId: string;
			applicationId: string;
			avatarId: string;
			profileRevision: number;
			visualRevision: number;
			artifactId: string;
	  };
export interface LifeImageAttempt {
	version: 1;
	attemptId: string;
	attemptNumber: number;
	owner: LifeImageIntent["owner"];
	intentId: string;
	intentDigest: string;
	briefDigest: string;
	route: ImageAttemptRoute;
	previousAttemptId: string | null;
	createdAtMs: number;
	revision: number;
	jobId: string | null;
	observation: ImageAttemptObservation | null;
	delivery: ImageAttemptDelivery;
}
export interface ImageAttemptSource {
	/** Must return the actual retained, historically validated intent; a boolean is not evidence. */
	intent(worldId: string, intentId: string): LifeImageIntent | null;
	/** No revision = current admission route; revision = immutable original route. */
	settings(worldId: string, revision?: number): LifeImageSettings | null;
	/** Actual count/dispatch receipt, required only for a new explicit retry. */
	count(worldId: string, attemptId: string): ImageCountRecord | null;
}
export type ImageAttemptOperation =
	| { kind: "prepare"; request: PrepareImageAttemptInput }
	| {
			kind: "retry";
			request: RetryImageAttemptInput;
			evidence: ImageCountRecord;
	  }
	| { kind: "link"; jobId: string }
	| { kind: "observe" | "recover"; observation: ImageAttemptObservation }
	| { kind: "acknowledge"; requestKey: string; delivery: ImageAttemptDelivery };
export interface ImageAttemptHistory {
	requestKey: string;
	operation: ImageAttemptOperation;
	recordedAtMs: number;
	result: LifeImageAttempt;
}
