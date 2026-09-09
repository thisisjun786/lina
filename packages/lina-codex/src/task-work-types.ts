/** Application-owned work evidence. Never accepted as a model tool argument. */
export type WorkOutcome =
	| "turn_ended"
	| "verified_result"
	| "failed"
	| "interrupted";
export type WorkNativeStatus = "completed" | "failed" | "interrupted";
export type WorkEvidenceRef = {
	kind: "owner_confirmation" | "verifier";
	authorityId: string;
	reference: string;
	/** The exact revision that the authority checked. */
	receiptRevision: number;
};
export type WorkReceipt = {
	version: 1;
	id: string;
	taskId: string;
	turnId: string;
	taskRevision: number;
	receiptRevision: number;
	ownerAgentId: string | null;
	participantAgentIds: string[];
	attributionStatus: "known" | "unknown";
	outcome: WorkOutcome;
	supersedesRevision: number | null;
	correction: null | { kind: "amend" | "retract"; reason: string };
	evidenceRefs: WorkEvidenceRef[];
};
export type ConfirmWorkInput = {
	receiptId: string;
	expectedReceiptRevision: number;
	requestId: string;
	evidenceRef: string;
};
export type CorrectWorkInput = {
	receiptId: string;
	expectedReceiptRevision: number;
	requestId: string;
	kind: "amend" | "retract";
	reason: string;
};
export type WorkSharingSelection = {
	worldIds: string[];
	categoryId: string;
	shareOutcome: boolean;
	shareParticipants: boolean;
	summary: string | null;
};
export type ShareWorkInput = {
	receiptId: string;
	expectedPolicyRevision: number;
	requestId: string;
	selection: WorkSharingSelection | null;
};
export type WorkSharingDecision = {
	version: 1;
	taskId: string;
	receiptId: string;
	policyRevision: number;
	selection: WorkSharingSelection | null;
};
/** The only task content eligible for model-facing projection. IDs/proofs stay private. */
export type SharedWorkFields = {
	categoryId: string;
	outcome: WorkOutcome | null;
	participantAgentIds: string[] | null;
	summary: string | null;
};
export type WorkDeliveryPayload = {
	version: 1;
	deliveryId: string;
	worldId: string;
	operation: "upsert" | "restrict";
	receipt: WorkReceipt;
	policyRevision: number;
	fields: SharedWorkFields | null;
};
export type WorkDeliveryStatus =
	| "pending"
	| "delivered"
	| "failed"
	| "withheld";
export type WorkDelivery = WorkDeliveryPayload & {
	payloadDigest: string;
	status: WorkDeliveryStatus;
	reason: string | null;
};
export type WorkDeliveryAttempt = {
	sequence: number;
	deliveryId: string;
	status: WorkDeliveryStatus;
	reason: string | null;
};
export type WorkProof = {
	taskId: string;
	receiptId: string;
	receiptRevision: number;
	policyRevision: number;
	worldId: string;
	payloadDigest: string;
};
export type WorkChange = { taskId: string; receiptId: string };

/** Opaque capability, minted only in trusted management/verifier composition. */
declare const workAuthority: unique symbol;
export type WorkAuthority = { readonly [workAuthority]: true };
export type WorkVerifierContext = {
	taskId: string;
	currentOwnerAgentId: string;
	receipt: WorkReceipt;
	evidenceRef: string;
};
