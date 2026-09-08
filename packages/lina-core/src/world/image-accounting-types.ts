import type { LifeConfig } from "./authoring-types.ts";
import type { LifeImageSettings } from "./image-types.ts";

/** Technical serialization/output ceilings; these do not grant a world any quota. */
export const MAX_IMAGE_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_ACCOUNTING_METADATA_BYTES = 256 * 1024;

export interface ImageAccountingBinding {
	worldId: string;
	agentId: string;
	intentId: string;
	attemptId: string;
	jobId: string;
	kind: "event" | "avatar";
	sourceLifeRevision: number;
	settingsRevision: number;
	configRevision: number;
	frozenDigest: string;
}
export interface ImageReservationInput {
	binding: ImageAccountingBinding;
	outputBytes: number;
	/** Bounds include the ledger's serialized records plus caller-owned metadata. */
	metadataBytes: number;
	manifestBytes: number;
}
export interface ImageAccountingSource {
	/** Omitted revision means current; supplied revision must resolve exact immutable history. */
	settings(worldId: string, revision?: number): LifeImageSettings | null;
	config(worldId: string, revision?: number): LifeConfig | null;
	/** Throw on missing/mismatched actual intent, attempt, linked UUID or source lineage.
	 * submit also verifies live authority; zero verifies owned preflight evidence;
	 * archive verifies terminal acknowledgement and the original retained manifest.
	 * Callbacks are synchronous and run inside the caller's SQLite transaction. */
	verifyAttempt(
		binding: ImageAccountingBinding,
		phase: "history" | "prepare" | "submit" | "zero" | "recover" | "archive",
	): void;
}
export type ImageSettlement =
	| { kind: "no_post" | "unknown" | "failed" }
	| { kind: "result"; resultFilename: string };
export interface ImageByteReceipt {
	sha256: string;
	size: number;
}
export interface ImageOutputReceipt extends ImageByteReceipt {
	id: string;
	mime: "image/png" | "image/jpeg";
}
export interface ImageCountRecord {
	version: 1;
	reservation: ImageReservationInput;
	createdAtMs: number;
	archived: boolean;
	dispatchAtMs: number | null;
	state: "prepared" | "unknown" | "attempted" | "released";
	terminal: "no_post" | "failed" | "result" | null;
	resultFilename: string | null;
}
export interface ImageStorageRecord {
	version: 1;
	outputState: "reserved" | "orphan" | "imported" | "released" | "abandoned";
	asset: ImageOutputReceipt | null;
	metadata: ImageByteReceipt | null;
	manifest: ImageByteReceipt | null;
}
export interface ImageArchiveRecord {
	version: 1;
	count: ImageCountRecord;
	metadata: ImageByteReceipt | null;
	manifest: ImageByteReceipt;
	receipt: ImageByteReceipt;
	acknowledged: true;
}
export interface ImageUsageSnapshot {
	worldId: string;
	atMs: number;
	windowMs: number | null;
	count: { reserved: number; consumed: number; total: number };
	storage: {
		activeJobs: number;
		archivedJobs: number;
		assets: number;
		outputBytes: number;
		metadataBytes: number;
		manifestBytes: number;
		archiveBytes: number;
		totalBytes: number;
	};
}
