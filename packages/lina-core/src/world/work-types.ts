/** Application receipt vocabulary; core does not depend on a task execution adapter. */
export type WorkOutcome =
	| "turn_ended"
	| "verified_result"
	| "failed"
	| "interrupted";
export type WorkRuleOutcome = WorkOutcome | "recorded";
export interface WorkInfluenceRule {
	id: string;
	familyId: string;
	categoryId: string;
	outcomes: WorkRuleOutcome[];
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
export interface WorkEvidenceRecordV1 {
	inputId: string;
	source: WorkInputSource;
}
export interface WorkEvidenceSnapshotV1 {
	version: 1;
	worldId: string;
	revision: number;
	permissionRevision: number;
	workConfigDigest: string;
	records: WorkEvidenceRecordV1[];
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

export type ResourceActivityOutcome = "recorded" | "verified_result" | "failed";
export interface ResourceActivityReceipt {
	activityId: string;
	activityRevision: number;
	supersedesRevision: number | null;
	resourceId: string;
	resourceRevision: number;
	versionId: string;
	memoryId: string | null;
	actorAgentId: string;
	participantAgentIds: string[];
	activityKind:
		| "development"
		| "research"
		| "writing"
		| "organization"
		| "search"
		| "other";
	outcome: ResourceActivityOutcome;
	evidenceDigest: string;
	grantId: string;
	grantRevision: number;
	correction: { kind: "amend" | "retract"; reason: string } | null;
}
export interface ResourceActivitySource {
	kind: "resource_activity";
	version: 1;
	deliveryId: string;
	operation: "upsert" | "restrict";
	sourceDigest: string;
	policyRevision: number;
	receipt: ResourceActivityReceipt;
	fields: {
		categoryId: string;
		outcome: ResourceActivityOutcome | null;
		participantAgentIds: string[] | null;
		summary: string | null;
	} | null;
}

/** New history format; legacy snapshot rows remain byte-for-byte v1 records. */
export type WorkEvidenceRecordV2 =
	| { origin: "codex-task"; inputId: string; source: WorkInputSource }
	| {
			origin: "resource-activity";
			inputId: string;
			source: ResourceActivitySource;
	  };
export type WorkEvidenceSnapshotV2 = Omit<
	WorkEvidenceSnapshotV1,
	"version" | "records"
> & {
	version: 2;
	records: WorkEvidenceRecordV2[];
};

export type WorkEvidenceSnapshot =
	| WorkEvidenceSnapshotV1
	| WorkEvidenceSnapshotV2;

export type WorkEvidenceRecord = WorkEvidenceRecordV1 | WorkEvidenceRecordV2;
