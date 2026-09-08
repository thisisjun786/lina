import type { EnsembleCheckpoint } from "./social-types.ts";
import type {
	WorldContext,
	WorldEvent,
	WorldProposal,
	WorldSnapshot,
} from "./types.ts";
import type { WorkInputSource } from "./work-types.ts";

export type ClaimRef = { kind: "world_fact" | "life_claim"; id: string };
export type DisclosureSubject = {
	kind: "world_event" | "world_scene" | "world_fact" | "life_claim";
	id: string;
};
/** Knowledge, permission to disclose, and publication recipients are independent. */
export interface DisclosurePolicy {
	knowers: string[];
	disclosures: Array<{ agentId: string; recipientId: string }>;
	publication: string[];
}
export type SecretPolicy = DisclosurePolicy;
export interface NumericAxis {
	id: string;
	label: string;
	min: number;
	max: number;
	initial: number;
}
export interface HabitDefinition {
	id: string;
	label: string;
	initial: boolean;
}
export interface ProjectionPolicy {
	revision: number;
	sharedTraitIds: string[];
	sharedHabitIds: string[];
	sharedAttitudeIds: string[];
	disclosures: Array<{ subject: DisclosureSubject; policy: DisclosurePolicy }>;
}
export interface LifeDefinition {
	version: 1;
	worldId: string;
	revision: number;
	participants: string[];
	traits: NumericAxis[];
	habits: HabitDefinition[];
	attitudes: NumericAxis[];
	projection: ProjectionPolicy;
}
export interface LifeClaim {
	id: string;
	text: string;
	sourceEventId: string;
	truth: "true" | "false" | "unknown";
	supersedes: string | null;
	disclosure: DisclosurePolicy;
}
export type KnowledgeClaim = LifeClaim;
/** Learning and disclosure authority have separate, immutable provenance. */
export interface KnowledgeGrant {
	id: string;
	claim: ClaimRef;
	fromAgentId: string;
	toAgentId: string;
	sourceEventId: string;
	experienceId: string;
	lifeRevision: number;
	definitionRevision: number;
	projectionRevision: number;
	policyDigest: string;
}
export interface AgentBelief {
	id: string;
	agentId: string;
	claim: ClaimRef;
	stance: "believes" | "disbelieves" | "uncertain";
	confidence: "uncertain" | "likely" | "certain";
	experienceIds: string[];
	supersedes: string | null;
}
export type BeliefDelta = AgentBelief;
export interface AgentExperience {
	id: string;
	agentId: string;
	eventId: string;
	channel: "direct" | "observed" | "told" | "inferred";
	claims: ClaimRef[];
	simulationTime: number;
}
export type GrowthDelta =
	| {
			kind: "trait";
			agentId: string;
			axisId: string;
			previous: number;
			next: number;
			evidenceIds: string[];
	  }
	| {
			kind: "habit";
			agentId: string;
			habitId: string;
			previous: boolean;
			next: boolean;
			evidenceIds: string[];
	  }
	| {
			kind: "attitude";
			fromAgentId: string;
			toAgentId: string;
			axisId: string;
			previous: number;
			next: number;
			evidenceIds: string[];
	  };
export interface IdentityProfilePolicy {
	agentId: string;
	profileRevision: number;
	evolution: "manual" | "adaptive";
	lockedTraitIds: string[];
	lockedHabitIds: string[];
	lockedAttitudeIds: string[];
}
export interface IdentityPolicySnapshot {
	version: 1;
	profiles: IdentityProfilePolicy[];
}
export interface EmptyEngineCheckpoint {
	version: 1;
	engineId: "empty";
	engineRevision: 0;
	ruleDigest: string;
	encodingVersion: 1;
	dataDigest: string;
	data: null;
}
export type EngineCheckpoint = EmptyEngineCheckpoint | EnsembleCheckpoint;
export interface TraitState {
	agentId: string;
	axisId: string;
	value: number;
	profileRevision: number | null;
}
export interface HabitState {
	agentId: string;
	habitId: string;
	value: boolean;
	profileRevision: number | null;
}
export interface AttitudeState {
	fromAgentId: string;
	toAgentId: string;
	axisId: string;
	value: number;
	profileRevision: number | null;
}
export interface GrowthRecord {
	lifeRevision: number;
	profileRevision: number;
	delta: GrowthDelta;
}
export interface GrowthState {
	traits: TraitState[];
	habits: HabitState[];
	attitudes: AttitudeState[];
	growthHistory: GrowthRecord[];
}
export interface LifeStateV1 extends GrowthState {
	version: 1;
	worldId: string;
	revision: number;
	worldRevision: number;
	definitionRevision: number;
	baseWorldRevision: number;
	claims: LifeClaim[];
	beliefs: AgentBelief[];
	experiences: AgentExperience[];
	checkpoint: EngineCheckpoint;
}
export type LifeStateV2 = Omit<LifeStateV1, "version"> & {
	version: 2;
	knowledgeGrants: KnowledgeGrant[];
};
export type LifeState = LifeStateV1 | LifeStateV2;
export interface SideEffectIntent {
	version: 1;
	worldId: string;
	id: string;
	lifeRevision: number;
	payload: { kind: "publication_candidate"; eventId: string };
	payloadDigest: string;
}
export interface LifeCommitV1 {
	version: 1;
	world: WorldProposal;
	expectedLifeRevision: number;
	definitionRevision: number;
	claims: LifeClaim[];
	beliefs: BeliefDelta[];
	experiences: AgentExperience[];
	growth: GrowthDelta[];
	checkpoint: EngineCheckpoint;
	consumedInputIds: string[];
	effects: SideEffectIntent[];
}
export type LifeCommitV2 = Omit<LifeCommitV1, "version"> & {
	version: 2;
	socialResolutionId: string;
	knowledgeGrants: KnowledgeGrant[];
};
export type LifeCommitV3 = Omit<
	LifeCommitV2,
	"version" | "socialResolutionId"
> & {
	version: 3;
	stepId: string;
	socialResolutionId: string | null;
};
export type LifeCommit = LifeCommitV1 | LifeCommitV2 | LifeCommitV3;
export interface LifeInputV1 {
	version: 1;
	worldId: string;
	id: string;
	sourceRevision: number;
	payloadDigest: string;
	source: { kind: "application"; sourceId: string; text: string };
	consumedLifeRevision: number | null;
}
export type LifeInputV2 = Omit<LifeInputV1, "version" | "source"> & {
	version: 2;
	source: WorkInputSource;
};
export type LifeInput = LifeInputV1 | LifeInputV2;
export interface AdmissionReceipt {
	worldId: string;
	inputId: string;
	payloadDigest: string;
	replayed: boolean;
}
export interface BindingSelectionV1 {
	worldId: string | null;
	projectionPolicyRevision: number;
}
export interface BindingSelectionV2 extends BindingSelectionV1 {
	version: 2;
	conversationRecipientId: string | null;
}
export type BindingSelection = BindingSelectionV1 | BindingSelectionV2;
export interface WorldBindingV1 extends BindingSelectionV1 {
	version: 1;
	agentId: string;
	revision: number;
}
export interface WorldBindingV2 extends BindingSelectionV2 {
	agentId: string;
	revision: number;
}
export type WorldBinding = WorldBindingV1 | WorldBindingV2;
export interface LifeReceipt {
	worldId: string;
	eventId: string;
	worldRevision: number;
	lifeRevision: number;
	inputDigest: string;
	replayed: boolean;
	identity: IdentityPolicySnapshot;
}
export interface LifePreview {
	world: WorldSnapshot;
	life: LifeState;
}
export interface LifeViewLimits {
	maxChars: number;
	maxRecords: number;
}
/** Supplied by the application after authorization, never parsed from model arguments. */
export interface AuthorScope {
	purpose: "author";
	worldId: string;
}
export interface PerceptionScope {
	purpose: "life";
	worldId: string;
	agentId: string;
}
export interface PublicationScope {
	purpose: "publication";
	worldId: string;
	agentId: string;
	recipientId: string;
}
export interface AuthorInspection {
	world: WorldSnapshot;
	life: LifeState;
	definition: LifeDefinition;
	events: WorldEvent[];
}
export interface SharedPersonaView {
	version: 1;
	worldId: string;
	agentId: string;
	lifeRevision: number;
	bindingRevision: number;
	projectionPolicyRevision: number;
	profileRevision: number;
	traits: Array<{ label: string; value: number }>;
	habits: Array<{ label: string; value: boolean }>;
	attitudes: Array<{ toAgentId: string; label: string; value: number }>;
	truncated: boolean;
}
export interface LifePerception {
	version: 1;
	worldId: string;
	agentId: string;
	lifeRevision: number;
	scene: WorldContext["scene"];
	facts: Array<{ id: string; text: string }>;
	claims: Array<{ id: string; text: string }>;
	beliefs: Array<{
		id: string;
		claim: ClaimRef;
		text: string;
		stance: AgentBelief["stance"];
		confidence: AgentBelief["confidence"];
	}>;
	experiences: Array<{
		id: string;
		channel: AgentExperience["channel"];
		claims: ClaimRef[];
		simulationTime: number;
	}>;
	attitudes: Array<{ toAgentId: string; label: string; value: number }>;
	truncated: boolean;
}
export interface PublicationView {
	version: 1;
	worldId: string;
	recipientId: string;
	lifeRevision: number;
	projectionPolicyRevision: number;
	events: Array<{ id: string; simulationTime: number; summary: string }>;
	facts: Array<{ id: string; text: string }>;
	claims: Array<{ id: string; text: string }>;
	scene: WorldContext["scene"];
	truncated: boolean;
}
