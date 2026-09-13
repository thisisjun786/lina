export { compilePersona } from "./persona.ts";
export { AgentStore } from "./store.ts";
export type {
	AgentChange,
	AgentInput,
	AgentProfile,
	Dynamics,
	EvolutionMode,
	ReflectionInput,
} from "./types.ts";
export {
	boundedId,
	boundedList,
	boundedText,
	validateAgentInput,
	validatePatch,
	validateReflection,
} from "./validation.ts";

export type * from "./visual.ts";
export {
	MAX_AVATAR_BYTES,
	MAX_AVATAR_FILES,
	MAX_AVATAR_TOTAL_BYTES,
} from "./visual-capacity.ts";
export {
	avatarAutomaticRequestKey,
	parseAgentVisual,
	parseAvatarAdmission,
	parseAvatarCandidate,
	parseAvatarPolicy,
	parseAvatarSource,
	parseAvatarSourceProof,
	parseFrozenVisualIdentity,
	parseVisualGrant,
	parseVisualInput,
	parseVisualPurpose,
	parseVisualReference,
	visualIdentityDigest,
} from "./visual-validation.ts";

// Judgment contracts.

export * from "./judgment.ts";
export {
	assessmentInputDigest,
	INTENTION_TRANSITIONS,
	intentionDigest,
	judgmentDigest,
	parseAssessment,
	parseAssessmentSet,
	parseIntentionRecord,
	parseIntentionTransition,
	parseJudgmentSnapshotRef,
	parseObjectiveProfile,
	parseObjectiveProfileRef,
	parseOptionAssessment,
	parseResolutionRecord,
	parseSelectionSpec,
	snapshotDigest,
	transitionIntention,
} from "./judgment-validation.ts";

// Persona schema contracts.

export type {
	DimensionSource,
	NeuralProjectionRef,
	PersonaDimensionRef,
} from "./behavior-types.ts";
export { DIMENSION_SOURCES } from "./behavior-types.ts";
export type {
	PersonaDimension,
	PersonaDimensionKind,
	PersonaSchema,
} from "./persona-schema.ts";
export {
	parsePersonaSchema,
	personaSchemaDigest,
	personaSchemaFromLifeDefinition,
} from "./persona-schema.ts";

// Personal catalog and arbitration policy.

export * from "./judgment-catalog.ts";
export * from "./judgment-policy.ts";

// Judgment persistence.

export { JUDGMENT_SCHEMA_VERSION } from "./judgment-schema.ts";
export { JudgmentStore } from "./judgment-store.ts";

// Behavior identity (pre-existing pure function; exposed so persona contract
// tests can pin the BehaviorJobInput fingerprint through the public barrel).

export { behaviorFingerprint } from "./behavior-validation.ts";

export * from "./judgment-candidates.ts";
export * from "./judgment-dialogue.ts";
