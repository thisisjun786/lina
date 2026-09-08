import type { EntryInput } from "../protocol.ts";
import type { SourceEntry, SourceProof } from "../source-policy-types.ts";

export const SUMMARY_TEXT_MAX_CHARS = 8192;
export const SUMMARY_SOURCES_MAX = 64;
export const EXPAND_TEXT_MAX_CHARS = 4096;
export const EXPAND_SOURCES_MAX = 16;
export const WORKING_GOAL_MAX_CHARS = 1000;
export const WORKING_LIST_MAX_ITEMS = 8;
export const WORKING_ITEM_MAX_CHARS = 300;
export const WORKING_SOURCES_MAX = 8;
export const CONTEXT_ID_MAX_CHARS = 256;

export type SourceKind = "entry" | "summary";

export interface SourceRef {
	kind: SourceKind;
	id: string;
}

export type SummaryKind = "model" | "extractive";

export interface SummaryNode {
	id: string;
	text: string;
	kind: SummaryKind;
	depth: number;
	sources: SourceRef[];
	fingerprint: string;
	sourceProofs: SourceProof[];
}

export interface StageInput {
	text: string;
	kind: SummaryKind;
	sources: SourceRef[];
}

export interface ActiveSummary {
	id: string;
	nativeEntryId: string;
	firstKeptEntryId: string;
	revision: number;
}

export interface ActivateInput {
	id: string;
	nativeEntryId: string;
	firstKeptEntryId: string;
	expectedActiveId: string | null;
}

export interface WorkingState {
	revision: number;
	goal: string;
	decisions: string[];
	openItems: string[];
	nextSteps: string[];
	sourceEntryIds: string[];
}

export type WorkingFields = Partial<Omit<WorkingState, "revision">>;

export interface ExpandOptions {
	offset?: number;
	sourceOffset?: number;
}

export interface ExpandPage {
	ref: SourceRef;
	text: string;
	nextOffset: number | null;
	sources: SourceRef[];
	nextSourceOffset: number | null;
}

/** Resolves an immutable durable entry by ID; never arbitrary file contents. */
export type LookupEntry = (
	id: string,
) => (EntryInput & SourceEntry) | undefined;

export interface ContextStoreOptions {
	/** Trusted request lookup returning the creating user entry, never model input. */
	lookupRequest?: (requestId: string) => SourceEntry | undefined;
}
export type ArtifactStatus = "pending" | "finalized" | "withheld";
export interface NoteReceipt {
	id: string;
	status: ArtifactStatus;
}
export interface ManagedNote {
	id: string;
	text: string;
	createdAt: string;
}
