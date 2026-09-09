import type { ImageJob, ImageOwner, ImageStoreLimits } from "./contracts.ts";
import { serializedBytes } from "./image-store-archive.ts";
import { MAX_JOBS, MAX_STORE_BYTES } from "./image-store-legacy.ts";
import { originKey } from "./image-store-schema.ts";

type ConversationOwner = Extract<ImageOwner, { kind: "conversation" }>;
/** Bound only the added v2 fields; original records retain their separate 8 MiB allowance. */
export function conversationStoreLimits(
	owner: ConversationOwner,
): ImageStoreLimits {
	// A JSON-escaped UTF-16 code unit takes at most six bytes. These are schema bounds, not new user quota.
	const maxText = "\u0000".repeat(256);
	const origin = {
		kind: "conversation" as const,
		requestId: maxText,
		callId: maxText,
	};
	const recordExtra = serializedBytes({
		owner,
		origin,
		reference: null,
		delivery: { kind: "conversation", entryId: maxText },
		artifactRecovery: null,
	}).length;
	const envelope = serializedBytes({
		version: 2,
		owner,
		jobs: [],
		archives: [],
	}).length;
	const archiveEnvelope = serializedBytes({
		version: 2,
		owner,
		job: null,
	}).length;
	const tombstone = serializedBytes({
		id: "00000000-0000-4000-8000-000000000000",
		key: originKey(origin),
		sha256: "f".repeat(64),
		bytes: Number.MAX_SAFE_INTEGER,
	}).length;
	const maxActiveBytes =
		MAX_STORE_BYTES + envelope + MAX_JOBS * (recordExtra + tombstone);
	const maxArchiveBytes =
		MAX_STORE_BYTES + MAX_JOBS * (recordExtra + archiveEnvelope);
	return {
		maxActiveJobs: MAX_JOBS,
		maxArchivedJobs: MAX_JOBS,
		maxActiveBytes,
		maxArchiveBytes,
		maxTotalBytes: MAX_STORE_BYTES + maxActiveBytes + maxArchiveBytes,
	};
}
export function assertConversationAllowance(
	owner: ConversationOwner,
	jobs: ImageJob[],
): void {
	const originals = jobs.map(
		({
			owner: _owner,
			origin: _origin,
			reference: _reference,
			delivery: _delivery,
			artifactRecovery: _recovery,
			...legacy
		}) => legacy,
	);
	if (
		jobs.length > MAX_JOBS ||
		Buffer.byteLength(
			JSON.stringify({ version: 1, binding: owner.binding, jobs: originals }),
		) > MAX_STORE_BYTES
	)
		throw Error("Image conversation record byte/count limit reached");
}
