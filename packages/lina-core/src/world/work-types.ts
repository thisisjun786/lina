/** Application receipt vocabulary; core does not depend on a task execution adapter. */
export type WorkOutcome =
	| "turn_ended"
	| "verified_result"
	| "failed"
	| "interrupted";
export interface WorkInfluenceRule {
	id: string;
	familyId: string;
	categoryId: string;
	outcomes: WorkOutcome[];
	attribution: "owner" | "participant";
	weight: number;
	requiredMatch: boolean;
}
export interface WorkConfig {
	rules: WorkInfluenceRule[];
}
export interface WorkReceiptProvenance {
	receiptId: string;
	receiptRevision: number;
	supersedesRevision: number | null;
	taskId: string;
	turnId: string;
	taskRevision: number;
	ownerAgentId: string | null;
	participantAgentIds: string[];
	attributionStatus: "known" | "unknown";
	outcome: WorkOutcome;
	correction: { kind: "amend" | "retract"; reason: string } | null;
	/** Hash of immutable source evidence; raw paths/references stay in the task DB. */
	evidenceDigest: string;
}
export interface SharedWorkFields {
	categoryId: string;
	outcome: WorkOutcome | null;
	participantAgentIds: string[] | null;
	summary: string | null;
}
export interface WorkInputSource {
	kind: "work";
	deliveryId: string;
	operation: "upsert" | "restrict";
	/** Original task-owner payload digest used when rechecking its current proof. */
	sourceDigest: string;
	policyRevision: number;
	receipt: WorkReceiptProvenance;
	fields: SharedWorkFields | null;
}
export interface WorkEvidenceRecord {
	inputId: string;
	source: WorkInputSource;
}
export interface WorkEvidenceSnapshot {
	version: 1;
	worldId: string;
	revision: number;
	permissionRevision: number;
	workConfigDigest: string;
	records: WorkEvidenceRecord[];
}
export interface WorkSourceRef {
	operation: "upsert" | "restrict";
	inputId: string;
	sourceDigest: string;
	workConfigDigest: string;
}
export interface WorkSubject {
	kind:
		| "world_event"
		| "world_scene"
		| "world_fact"
		| "life_claim"
		| "experience"
		| "goal";
	id: string;
}
export interface WorkAncestryRecord {
	subject: WorkSubject;
	lifeRevision: number;
	refs: WorkSourceRef[];
}
