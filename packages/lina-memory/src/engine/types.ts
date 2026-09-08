import type {
	SourceLookup,
	SourceProof,
} from "../../../lina-core/src/source-policy-types.ts";

export type { SourceEntry } from "../../../lina-core/src/source-policy-types.ts";

/** These records are reference data, never authored identity or preference writes. */
export interface Observation {
	subject: "user" | "self" | "relationship";
	kind: "fact" | "interest" | "preference" | "concern" | "mood" | "attitude";
	key: string;
	text: string;
	evidence: "explicit" | "inferred";
	sources: SourceQuote[];
	status?: "active" | "resolved" | "retracted";
}
export interface SourceQuote {
	entryId: string;
	quote: string;
}
export type LookupEntry = SourceLookup;
export interface EngineOptions {
	now?: () => number;
	lookup: LookupEntry;
	sourceSequence?: (entryId: string) => number | undefined;
}
export interface EngineRecord extends Omit<Observation, "status"> {
	/** Originating processing receipt; omission keeps old records unqualified. */
	sourceRequestId?: string;
	/** Absent only on preserved legacy records; those are never model eligible. */
	sourceProofs?: SourceProof[];
	id: string;
	agentId: string;
	status: "active" | "resolved" | "retracted";
	support: "provisional" | "supported";
	/** Bound user entries, computed by storage, never accepted from model output. */
	userSourceIds?: string[] | undefined;
	generation: number;
	revision: number;
	createdAt: number;
	updatedAt: number;
	validFrom: number;
	expiresAt: number | null;
	invalidatedAt: number | null;
}
export interface EngineSnapshot {
	agentId: string;
	revision: number;
	asOf: number;
	records: EngineRecord[];
	truncated: boolean;
}
export type EngineState = EngineSnapshot;
export interface ApplyInput {
	/** Missing proofs fail closed, including empty deltas. */
	sourceProofs?: SourceProof[];
	requestId: string;
	expectedRevision: number;
	observations: Observation[];
}
export const ENGINE_READ_MAX = 200;
export const ENGINE_BATCH_MAX = 50;
export const ENGINE_SOURCES_MAX = 64;
export const ENGINE_TEXT_MAX = 2000;
export const ENGINE_RENDER_MAX = 32000;
export const ENGINE_MOOD_TTL_MS = 6 * 60 * 60 * 1000;
