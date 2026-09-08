import type { AgentProfile } from "../agents/types.ts";
import type { LifeConfig, Scalar, WorldPackV3 } from "./authoring-types.ts";
import type {
	AgentBelief,
	ClaimRef,
	IdentityPolicySnapshot,
	LifeCommitV3,
	LifeInput,
	LifeReceipt,
	LifeState,
} from "./life-types.ts";
import type { SocialExtensionIntent, TargetResponse } from "./social-types.ts";
import type { WorldSnapshot } from "./types.ts";

export interface NeedDefinition {
	id: string;
	label: string;
	min: number;
	max: number;
	initial: number;
	driftPerStep: number;
}
export interface GoalDefinition {
	id: string;
	agentId: string;
	description: string;
	priority: number;
	familyIds: string[];
}
export interface AutonomousEventPolicy {
	familyId: string;
	capabilityIds: string[];
	cooldownSteps: number;
	noveltyPenalty: number;
	goalWeight: number;
	needWeights: Array<{ needId: string; multiplier: number }>;
	traitWeights: Array<{ axisId: string; multiplier: number }>;
	habitWeights: Array<{ habitId: string; when: boolean; weight: number }>;
}
export interface AutonomyDefinition {
	version: 1;
	needs: NeedDefinition[];
	goals: GoalDefinition[];
	events: AutonomousEventPolicy[];
	quietWeight: number;
	growth: { maxNumericDelta: number; minHabitExperiences: number };
}
export interface NeedState {
	agentId: string;
	needId: string;
	value: number;
	lastStepId: string | null;
	experienceIds: string[];
}
export interface GoalState extends GoalDefinition {
	progress: number;
	status: "active" | "completed" | "abandoned";
	createdAtStepId: string | null;
	lastStepId: string | null;
	experienceIds: string[];
}
export interface CausalEvent {
	id: string;
	familyId: string;
	actorIds: string[];
	summary: string;
	parentStepId: string;
	rootStepId: string;
	depth: number;
	status: "pending" | "stopped";
}
export interface AutonomyState {
	version: 1;
	worldId: string;
	worldRevision: number;
	lifeRevision: number;
	packVersion: number;
	stepNumber: number;
	seed: number;
	selectionIndex: number;
	variables: Record<string, Scalar>;
	needs: NeedState[];
	goals: GoalState[];
	families: Array<{
		familyId: string;
		agentId: string;
		lastStepNumber: number;
		count: number;
	}>;
	pendingEvents: CausalEvent[];
}
export interface AutonomySource {
	world: WorldSnapshot;
	life: LifeState;
	pack: WorldPackV3;
	config: LifeConfig;
	identity: IdentityPolicySnapshot;
	profiles: AgentProfile[];
	autonomy: AutonomyState;
	inputs: LifeInput[];
	modelSettingsRevision: number;
}
export interface EventCandidate {
	id: string;
	familyId: string;
	agentId: string;
	weight: number;
	contributions: Array<{
		kind: "base" | "need" | "goal" | "trait" | "habit" | "novelty";
		id: string;
		value: number;
	}>;
}
export interface EventDecision {
	version: 1;
	stepId: string;
	kind: "quiet" | "event";
	familyId: string | null;
	agentId: string | null;
	simulationTime: number;
	candidates: EventCandidate[];
	random: { seed: number; index: number; value: number };
	parent: CausalEvent | null;
	maxModelCalls: number;
}
export type LifeModelLane = "director" | "actor" | "target" | "reflection";
export interface LifeModelLimits {
	maxInputTokens: number;
	maxOutputTokens: number;
	maxInputBytes: number;
	maxOutputBytes: number;
	timeoutMs: number;
}
/** Trusted runtime request. Neither source identities nor the route come from model output. */
export interface LifeModelRequest {
	version: 1;
	id: string;
	worldId: string;
	stepId: string;
	lane: LifeModelLane;
	agentId: string;
	provider: string;
	model: string;
	modelSettingsRevision: number;
	systemPrompt: string;
	input: string;
	limits: LifeModelLimits;
}
export interface PreparedLifeModelRequest {
	version: 1;
	request: LifeModelRequest;
	inputDigest: string;
	capabilityFingerprint: string;
	nativeReference: string;
}
export interface LifeModelUsage {
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
}
export interface LifeModelResult {
	version: 1;
	requestId: string;
	inputDigest: string;
	capabilityFingerprint: string;
	nativeReference: string;
	provider: string;
	model: string;
	threadId: string;
	turnId: string;
	text: string;
	usage: LifeModelUsage;
	upstreamAttempts: 1;
}
export type LifeModelReconciliation =
	| { status: "not_dispatched" }
	| { status: "unknown"; usage?: LifeModelUsage; upstreamAttempts?: 0 | 1 }
	| { status: "completed"; result: LifeModelResult }
	| {
			status: "failed";
			usage: LifeModelUsage;
			upstreamAttempts: 0 | 1;
			reason: string;
	  };
export interface LifeModelRecord {
	prepared: PreparedLifeModelRequest;
	status: "prepared" | "dispatched" | "completed" | "unknown" | "failed";
	preparedAt: number;
	dispatchedAt: number | null;
	result: LifeModelResult | null;
	usage: LifeModelUsage;
	reservation: { inputTokens: number; outputTokens: number };
	upstreamAttempts: 0 | 1 | null;
	error: string | null;
}
/** A model proposes its own beliefs and bounded changes; it supplies no authority or truth flag. */
export interface ReflectionProposal {
	claims: Array<{ id: string; text: string; supersedes: string | null }>;
	beliefs: Array<{
		id: string;
		claim: ClaimRef;
		stance: AgentBelief["stance"];
		confidence: AgentBelief["confidence"];
		experienceIds: string[];
		supersedes: string | null;
	}>;
	growth: Array<
		| { kind: "trait"; axisId: string; next: number; evidenceIds: string[] }
		| { kind: "habit"; habitId: string; next: boolean; evidenceIds: string[] }
	>;
	needs: Array<{ needId: string; next: number; experienceIds: string[] }>;
	goals: Array<{
		id: string;
		description: string;
		priority: number;
		familyIds: string[];
		progress: number;
		status: GoalState["status"];
		experienceIds: string[];
	}>;
}
export interface StepReflection {
	agentId: string;
	requestId: string;
	proposal: ReflectionProposal;
}
export interface AutonomyOutcome {
	version: 1;
	stepId: string;
	kind: "quiet" | "activity" | "extension_required";
	commit: LifeCommitV3;
	nextState: AutonomyState;
}
export interface LifeLease {
	worldId: string;
	owner: string;
	generation: number;
	token: number;
	expiresAt: number;
}
export interface LifeSchedule {
	worldId: string;
	generation: number;
	configRevision: number;
	lease: LifeLease | null;
	nextDue: number | null;
	lastStepId: string | null;
	lastClock: number;
	leaseSequence: number;
	lastSkippedIntervals: number;
}
export interface LifeStep {
	version: 1;
	id: string;
	worldId: string;
	idempotencyKey: string;
	status:
		| "prepared"
		| "running"
		| "ready"
		| "accepted"
		| "needs_attention"
		| "failed"
		| "stale";
	source: AutonomySource;
	decision: EventDecision;
	lease: LifeLease;
	models: LifeModelRecord[];
	intent: SocialExtensionIntent | null;
	targetResponse: TargetResponse | null;
	socialRequestId: string | null;
	reflectionAgentIds: string[] | null;
	outcome: AutonomyOutcome | null;
	receipt: LifeReceipt | null;
	error: string | null;
}
export interface AutonomyMigrationPreview {
	version: 1;
	fromPackVersion: number;
	toPackVersion: number;
	worldRevision: number;
	lifeRevision: number;
	previousStateDigest: string;
	nextStateDigest: string;
	operations: Array<{
		kind:
			| "need_added"
			| "goal_added"
			| "agent_added"
			| "agent_retired"
			| "policy_changed";
		id: string;
	}>;
	digest: string;
}
export interface LifeUsageStatus {
	inputTokens: number;
	outputTokens: number;
	reservedInputTokens: number;
	reservedOutputTokens: number;
	unknownRequests: number;
	upstreamAttempts: number;
	monetaryCost: "unknown";
}
export interface LifeRunStatus {
	worldId: string;
	status:
		| "not_configured"
		| "paused"
		| "ready"
		| "running"
		| "needs_attention"
		| "budget_exhausted";
	missing: string[];
	schedule: LifeSchedule | null;
	activeStepId: string | null;
	usage: LifeUsageStatus;
}
