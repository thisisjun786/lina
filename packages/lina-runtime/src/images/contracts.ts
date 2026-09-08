import type { AttachmentMetadata } from "../../../lina-core/src/attachments/types.ts";
import type { ImageOwner } from "../../../lina-core/src/world/image-types.ts";
import type { Ima2SubmissionSnapshot } from "./client-types.ts";
import type { LegacyImageJob } from "./image-store-legacy.ts";

export type { ImageOwner } from "../../../lina-core/src/world/image-types.ts";
export type ConversationImageInput = {
	requestId: string;
	callId: string;
	provider: string;
	model: string;
	prompt: string;
	sourceArtifactId: string | null;
};
export type ImageOrigin =
	| { kind: "conversation"; requestId: string; callId: string }
	| { kind: "life"; intentId: string; attemptId: string; briefDigest: string };
/** Permission/grant snapshots belong to the frozen core brief; this binds its exact bytes. */
export type FrozenImageReference = {
	owner:
		| { kind: "agent"; agentId: string }
		| Extract<ImageOwner, { kind: "conversation" }>;
	referenceId: string;
	assetId: string;
	sha256: string;
	mime: "image/png" | "image/jpeg";
	size: number;
};
export type LifeImageInput = {
	origin: Extract<ImageOrigin, { kind: "life" }>;
	provider: string;
	model: string;
	prompt: string;
	reference: FrozenImageReference | null;
};
export type ImageJobInput = ConversationImageInput | LifeImageInput;
export type ImageCompletion =
	| { kind: "pending" }
	| { kind: "conversation"; entryId: string }
	| { kind: "life"; receiptId: string };
export type ImageReferenceBytes = {
	bytes: Uint8Array;
	mime: "image/png" | "image/jpeg";
};
type Awaitable<T> = T | Promise<T>;
export interface ImageArtifactPort {
	resolveReference(input: ImageJobInput): Awaitable<ImageReferenceBytes | null>;
	/** Reserve/reacquire bounded output capacity; no provider work. */
	preflight(job: ImageJob): Awaitable<void>;
	/** Stable UUID import must adopt matching retained bytes and reject conflicts. */
	importOutput(
		job: ImageJob,
		output: ImageReferenceBytes,
	): Awaitable<AttachmentMetadata>;
	verify(job: ImageJob): Awaitable<void>;
}
export interface ImageCompletionPort {
	complete(job: ImageJob): Awaitable<ImageCompletion>;
}
export type ImageStartAuthority = {
	/** Runtime verifies the WorldStore UUID link, current authority and reservations here. */
	beforeSubmit(job: ImageJob, snapshot: Ima2SubmissionSnapshot): undefined;
};
export type ImageStoreLimits = {
	maxActiveJobs: number;
	maxArchivedJobs: number;
	maxActiveBytes: number;
	maxArchiveBytes: number;
	maxTotalBytes: number;
};

export type ImageJob = Omit<LegacyImageJob, "requestId" | "callId"> & {
	requestId: string | null;
	callId: string | null;
	owner: ImageOwner;
	origin: ImageOrigin;
	reference: FrozenImageReference | null;
	delivery: ImageCompletion;
	artifactRecovery: {
		failedAt: string;
		error: string | null;
		delivery: ImageCompletion;
	} | null;
};
