export const MODULE_KINDS = ["clotho", "lachesis", "atropos"] as const;
export type ModuleKind = (typeof MODULE_KINDS)[number];
export const STANCES = ["prefer", "accept", "oppose", "unavailable"] as const;
export type Stance = (typeof STANCES)[number];
export const SEVERITIES = [
	"commitment_breach",
	"infeasible",
	"preference",
] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SITUATIONS = ["user_request", "autonomous", "transition"] as const;
export type Situation = (typeof SITUATIONS)[number];
export const INTENTION_KINDS = [
	"user_commitment",
	"autonomous_goal",
	"task_binding",
] as const;
export type IntentionKind = (typeof INTENTION_KINDS)[number];
export const INTENTION_STATUSES = [
	"proposed",
	"adopted",
	"active",
	"suspended",
	"completed",
	"cancelled",
] as const;
export type IntentionStatus = (typeof INTENTION_STATUSES)[number];
export const INTENTION_RELATIONS = [
	"depends",
	"conflicts",
	"supersedes",
] as const;
export type IntentionRelation = (typeof INTENTION_RELATIONS)[number];
export const ACCEPTED_BY = ["user", "host_autonomy"] as const;
export type AcceptedBy = (typeof ACCEPTED_BY)[number];
export const ROUND_STATUSES = ["open", "resolved", "deferred", "held"] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];
export const EXCLUSION_STAGES = [
	"host_eligibility",
	"commitment_protection",
	"infeasible",
] as const;
export type ExclusionStage = (typeof EXCLUSION_STAGES)[number];

export type ObjectiveProfile = {
	schemaVersion: 1;
	objectiveId: string;
	moduleKind: ModuleKind;
	revision: number;
	objective: string;
	comparisonCriteria: string[];
	reconsiderationConditions: string[];
};
export type ObjectiveProfileRef = {
	objectiveId: string;
	revision: number;
	digest: string;
};
export type SourceRef = { kind: string; id: string; revision: number };
export type JudgmentSnapshotRef = {
	schemaVersion: 1;
	roundId: string;
	agentId: string;
	scopeId: string;
	sourceRefs: SourceRef[];
	workingRevision: number;
	instructionRevision: number;
	policyId: string;
	policyRevision: number;
	identityRevision: number;
	domainRevisions: Record<string, number>;
	intentionRevision: number;
	objectiveProfileRefs: Record<ModuleKind, ObjectiveProfileRef>;
	observationRef: string | null;
	frozenNeuralRef: string | null;
	situation: Situation;
	clockId: string;
	sequence: number;
	bindingGeneration: number;
};

/** Opaque until produced by a versioned option catalog. */
export type OptionKey = string;
/** Nested shape, versioned by Assessment. */
export type OptionAssessment = {
	optionKey: OptionKey;
	stance: Stance;
	severity: Severity | null;
	unavailableReason: string | null;
	gain: string;
	loss: string;
	uncertainty: string;
	evidenceRefs: string[];
};
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type AssessmentDetail = {
	kind: "forecasts" | "values" | "continuity";
	body: JsonObject;
};
export type Assessment = {
	schemaVersion: 1;
	snapshotId: string;
	snapshotDigest: string;
	inputDigest: string;
	objectiveRef: ObjectiveProfileRef;
	mechanismRevision: number;
	completeText: string;
	evidenceRefs: string[];
	proposedOptionKeys: OptionKey[];
	objectiveAssessments: OptionAssessment[];
	recommendedOptionKeys: OptionKey[];
	diagnostics: JsonObject;
} & (
	| { moduleKind: "clotho"; detail: { kind: "forecasts"; body: JsonObject } }
	| { moduleKind: "lachesis"; detail: { kind: "values"; body: JsonObject } }
	| { moduleKind: "atropos"; detail: { kind: "continuity"; body: JsonObject } }
);
export type AssessmentSet = {
	schemaVersion: 1;
	roundId: string;
	snapshotDigest: string;
	assessments: Assessment[];
};
export type ResolutionRecord = {
	schemaVersion: 1;
	roundId: string;
	policyId: string;
	policyRevision: number;
	situation: Situation;
	order: ModuleKind[];
	recommendations: Record<ModuleKind, OptionKey[]>;
	conflicts: Array<{
		optionKey: OptionKey;
		stances: Record<ModuleKind, Stance>;
	}>;
	excluded: Array<{
		optionKey: OptionKey;
		stage: ExclusionStage;
		byModule: ModuleKind | null;
		reason: string;
	}>;
	abstentions: Array<{
		optionKey: OptionKey;
		moduleKind: ModuleKind;
		reason: string;
	}>;
	ranking: Array<{ optionKey: OptionKey; rank: number }>;
	conceded: Array<{ moduleKind: ModuleKind; optionKey: OptionKey }>;
	status: Exclude<RoundStatus, "open">;
	holdReason: string | null;
};
export type SelectionSpec = {
	schemaVersion: 1;
	roundId: string;
	snapshotDigest: string;
	assessmentSetDigest: string;
	objectiveProfileRefs: Record<ModuleKind, ObjectiveProfileRef>;
	resolutionDigest: string;
	policyId: string;
	policyRevision: number;
	situation: Situation;
	lambda: number;
	candidates: Array<{ optionKey: OptionKey; p0: number; b: number | null }>;
	eligibleDigest: string;
	specDigest: string;
};
/** Nested shape, versioned by IntentionRecord. */
export type IntentionTransition = {
	from: IntentionStatus;
	to: IntentionStatus;
	reason: string;
	evidenceRef: string | null;
	at: string;
};
export type IntentionRecord = {
	schemaVersion: 1;
	intentionId: string;
	agentId: string;
	scopeId: string;
	revision: number;
	kind: IntentionKind;
	purposeRef: string;
	text: string;
	acceptance: {
		sourceRef: string;
		acceptedBy: AcceptedBy;
		policyRevision: number;
		acceptedAt: string;
	};
	priority: number;
	deadline: string | null;
	completionCondition: string;
	abortConditions: string[];
	relatedIntentions: Array<{
		intentionId: string;
		relation: IntentionRelation;
	}>;
	status: IntentionStatus;
	history: IntentionTransition[];
};
