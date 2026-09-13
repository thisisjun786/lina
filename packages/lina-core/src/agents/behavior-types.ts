export const BEHAVIOR_JOB_STATES = [
	"pending",
	"prepared",
	"committed",
	"failed",
	"withheld",
] as const;
export type BehaviorJobState = (typeof BEHAVIOR_JOB_STATES)[number];

export const BEHAVIOR_FAIL_REASONS = [
	"provider_failed",
	"source_withheld",
	"cancelled",
	"invalid_output",
	"interrupted_outcome_unknown",
	"configuration_changed",
	"stale_revision",
] as const;
export type BehaviorFailReason = (typeof BEHAVIOR_FAIL_REASONS)[number];

/** Frozen memory reference. No original prose. */
export type BehaviorRecordRef = {
	proofs: import("../source-policy.ts").SourceProof[];
	recordId: string;
	revision: number;
	contentHash: string;
	proofDigest: string;
};

export type FrozenTraitSelector = {
	axisId: string;
	min: number;
	max: number;
};

export type FrozenHabitSelector = {
	habitId: string;
};

/**
 * Frozen interpretation input. Selectors are the allowlisted definition
 * dimensions for this job. Fingerprint ignores record.revision and promptDigest.
 */
export type BehaviorJobInput = {
	version: 1;
	agentId: string;
	worldId: string;
	profileRevision: number;
	definitionRevision: number;
	projectionRevision: number;
	policyRevision: number;
	modelSettingsRevision: number;
	definitionDigest: string;
	projectionDigest: string;
	promptDigest: string;
	maxAttempts: number;
	records: BehaviorRecordRef[];
	selectors: {
		traits: FrozenTraitSelector[];
		habits: FrozenHabitSelector[];
	};
};

export type PersonalTraitOutput = {
	axisId: string;
	value: number;
	evidenceIds: string[];
};

export type PersonalHabitOutput = {
	habitId: string;
	value: boolean;
	evidenceIds: string[];
};

export type PersonalBehaviorOutput = {
	traits: PersonalTraitOutput[];
	habits: PersonalHabitOutput[];
};

export type PersonalBehavior = {
	traits: Array<{ axisId: string; value: number }>;
	habits: Array<{ habitId: string; value: boolean }>;
};

/**
 * Host eligibility is outside this stamp. Availability is not digested.
 * IdentityPolicySnapshot v2 stores personalBehavior|null + sourceStamp|null.
 */
export type BehaviorSourceStamp = {
	digest: string;
	receiptRevision: number;
	profileRevision: number;
	definitionRevision: number;
	projectionRevision: number;
};

export type CurrentBehaviorProjection = {
	agentId: string;
	worldId: string;
	personalBehavior: PersonalBehavior | null;
	sourceStamp: BehaviorSourceStamp | null;
};

export type BehaviorClaim = {
	id: string;
	token: string;
	attempt: number;
	expectedRevision: number;
};

export type BehaviorJob = {
	id: string;
	agentId: string;
	worldId: string;
	fingerprint: string;
	input: BehaviorJobInput;
	state: BehaviorJobState;
	token: string | null;
	attempts: number;
	error: BehaviorFailReason | null;
	resultRevision: number | null;
};

export type BehaviorReceipt = {
	id: string;
	jobId: string;
	agentId: string;
	worldId: string;
	revision: number;
	input: BehaviorJobInput;
	output: PersonalBehaviorOutput;
	promptDigest: string;
	sourceStamp: BehaviorSourceStamp;
};

/** Runtime-owned currentness check. Never a model-supplied callback. */
export type BehaviorSourceVerifier = (input: BehaviorJobInput) => boolean;

/** AgentStore-owned enclosing transaction. This owner must not BEGIN. */
export type BehaviorTransaction = <T>(fn: () => T) => T;

export type BehaviorProfileView = {
	id: string;
	revision: number;
	evolution: "adaptive" | "manual";
};

export type BehaviorProfileGetter = (
	id: string,
) => BehaviorProfileView | undefined;

/** AgentStore-owned persistence. Caller supplies the enclosing transaction. */
export interface BehaviorPersistence {
	reactivate(jobId: string, assertCurrent: BehaviorSourceVerifier): BehaviorJob;
	enqueue(input: BehaviorJobInput): BehaviorJob;
	claim(jobId: string, expectedRevision: number): BehaviorClaim | undefined;
	commit(
		claim: BehaviorClaim,
		output: unknown,
		assertCurrent: BehaviorSourceVerifier,
	): BehaviorReceipt;
	fail(claim: BehaviorClaim, reason: BehaviorFailReason): BehaviorJob;
	recover(): void;
	get(jobId: string): BehaviorJob | undefined;
	revision(agentId: string, worldId: string): number;
	audit(): void;
	current(
		agentId: string,
		worldId: string,
		assertCurrent: BehaviorSourceVerifier,
	): CurrentBehaviorProjection;
	status(agentId: string): BehaviorJob[];
}

export const DIMENSION_SOURCES = ["reflection", "neural"] as const;
export type DimensionSource = (typeof DIMENSION_SOURCES)[number];
export type PersonaDimensionRef = {
	schemaRevision: number;
	dimensionId: string;
	source: DimensionSource;
};
/** F2 fills this; F1 declares the shape only. */
export type NeuralProjectionRef = {
	schemaVersion: 1;
	agentId: string;
	scopeId: string;
	schemaRevision: number;
	observationRef: string;
	projectionDigest: string;
};
