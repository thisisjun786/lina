import type { RequestStatus } from "./protocol.ts";

export type SourceScope = "ordinary" | "life" | "mixed" | "unclassified_legacy";
export type SourceMaterialKind =
	| "shared-growth"
	| "disclosed-life"
	| "author-world";
export interface SourcePolicy {
	version: 1;
	scope: SourceScope;
	sessionId: string;
	requestId: string;
	nativeEpoch: number;
	scopeDigest: string;
	policyRevision: number;
	contextReceiptIds: string[];
	materialKinds: SourceMaterialKind[];
}
export interface SourceProof {
	entryId: string;
	policyRevision: number;
	policyDigest: string;
}
/** Returned by the journal owner; source fields in content/raw are never used. */
export interface SourceEntry {
	entryId: string;
	role?: "user" | "assistant" | "tool" | "meta" | undefined;
	text: string;
	timestamp?: string | undefined;
	sourcePolicy?: SourcePolicy | undefined;
	requestStatus?: RequestStatus | undefined;
}
export type SourceLookup = (entryId: string) => SourceEntry | undefined;
/** Only the runtime's current working-context path may use this exception. */
export interface SourceContextOptions {
	activeRequestId?: string;
}
