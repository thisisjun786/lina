import type { Scalar, VariableDefinition } from "./authoring-types.ts";
import type {
	ClaimRef,
	EngineCheckpoint,
	IdentityPolicySnapshot,
	LifeDefinition,
	LifeState,
} from "./life-types.ts";
import type { WorldSnapshot } from "./types.ts";

export type SocialReference =
	| { kind: "actor" }
	| { kind: "target" }
	| { kind: "binding"; id: string }
	| { kind: "agent"; agentId: string };
export type SocialBinding = {
	id: string;
	roleId: string | null;
	agentId: string | null;
};
export type SocialCondition = {
	predicateId: string;
	first: SocialReference;
	second: SocialReference | null;
	operator: "=" | ">" | "<";
	value: number | boolean;
	window: { mostRecent: number; leastRecent: number } | null;
};
export type SocialPredicateEffect = {
	predicateId: string;
	first: SocialReference;
	second: SocialReference | null;
	operator: "=" | "+" | "-";
	value: number | boolean;
};
export type SocialPredicatePolicy = {
	predicateId: string;
	duration: number | null;
	visibility:
		| { kind: "public" }
		| { kind: "first" }
		| { kind: "agents"; agentIds: string[] };
	resource: boolean;
	attitudeAxisId: string | null;
};
export type SocialTriggerRule = {
	id: string;
	bindings: SocialBinding[];
	conditions: SocialCondition[];
	effects: SocialPredicateEffect[];
};
export type SocialVolitionRule = {
	id: string;
	bindings: SocialBinding[];
	conditions: SocialCondition[];
	effects: Array<{
		predicateId: string;
		first: SocialReference;
		second: SocialReference | null;
		intentType: boolean;
		weight: number;
	}>;
};
export type SocialInfluence = {
	conditions: SocialCondition[];
	weight: number;
};
type SocialActionBase = {
	id: string;
	bindings: SocialBinding[];
	conditions: SocialCondition[];
	influence: SocialInfluence[];
};
export type SocialAction = SocialActionBase &
	(
		| {
				kind: "root";
				intent: { predicateId: string; intentType: boolean };
				children: string[];
		  }
		| { kind: "group"; children: string[] }
		| {
				kind: "terminal";
				acceptance: "accepted" | "rejected" | "either";
				effects: SocialPredicateEffect[];
		  }
	);
export type SocialPrimitive =
	| { kind: "move"; sceneId: string }
	| { kind: "attempt"; rootActionId: string }
	| {
			kind: "transfer";
			predicateId: string;
			toAgentId: string;
			amount: number;
	  }
	| { kind: "reveal"; claim: ClaimRef; toAgentId: string }
	| { kind: "goal"; goalId: string; description: string };
export type SocialCapability = {
	id: string;
	description: string;
	actorRoleIds: string[];
	targetRoleIds: string[];
	knownTo: string[];
	primitives: SocialPrimitive["kind"][];
	rootActionId: string | null;
	conditions: SocialCondition[];
};
export type SocialDefinition = {
	version: 1;
	policies: SocialPredicatePolicy[];
	triggers: SocialTriggerRule[];
	volitions: SocialVolitionRule[];
	actions: SocialAction[];
	capabilities: SocialCapability[];
};
export type SocialIntent = {
	id: string;
	agentId: string;
	targetAgentId: string | null;
	capabilityId: string;
	description: string;
	primitives: SocialPrimitive[];
};
export type SocialExtensionIntent = Omit<SocialIntent, "primitives"> & {
	primitives: Array<
		| SocialPrimitive
		| { kind: "extension"; primitiveKind: string; proposal: string }
	>;
};
export type SocialIntentInspection =
	| { kind: "intent"; intent: SocialIntent }
	| { kind: "extension"; intent: SocialExtensionIntent };
export type TargetResponse = {
	intentId: string;
	agentId: string;
	decision: "accept" | "reject";
};
export type SocialRng = {
	algorithm: "lcg32-v1";
	seed: number;
	state: number;
	drawIndex: number;
};
export type SocialBootstrap = {
	version: 1;
	worldId: string;
	algorithm: SocialRng["algorithm"];
	seed: number;
	digest: string;
};
/** Tagged records preserve upstream undefined values and named array properties. */
export type SocialEncodedValue =
	| ["undefined"]
	| ["value", Scalar | null]
	| ["object", Array<[string, SocialEncodedValue]>]
	| ["array", number, Array<[string, SocialEncodedValue]>];
export type SocialIntroduction = {
	id: string;
	socialStep: number;
	worldRevision: number;
};
export type EnsembleState = {
	history: SocialEncodedValue;
	step: number;
	offstage: string[];
	eliminated: string[];
	iterators: Record<string, number>;
	noRepeat: Record<string, number>;
	volitionCache: SocialEncodedValue;
	cachePositions: Record<string, number>;
};
export type EnsembleCheckpoint = {
	version: 1;
	engineId: "ensemble";
	engineRevision: "8b74bdec-lina-1";
	ruleDigest: string;
	encodingVersion: 1;
	dataDigest: string;
	data: {
		worldId: string;
		packVersion: number;
		worldRevision: number;
		lifeRevision: number;
		simulationTime: number;
		compilerRevision: 1;
		schemaDigest: string;
		actionDigest: string;
		cast: string[];
		variables: Record<string, Scalar>;
		predicateIntroductions: SocialIntroduction[];
		agentIntroductions: SocialIntroduction[];
		variableIntroductions: SocialIntroduction[];
		state: EnsembleState;
		rng: SocialRng;
	};
};
export type CompiledSocialPredicate = {
	id: string;
	type: "number" | "boolean";
	direction: "directed" | "reciprocal" | "undirected";
	initial: number | boolean;
	min: number | null;
	max: number | null;
	policy: SocialPredicatePolicy;
};
/** Lina's canonical, typed compiler product; never arbitrary upstream JSON. */
export type CompiledSocialPack = {
	version: 1;
	compilerRevision: 1;
	worldId: string;
	packVersion: number;
	digest: string;
	schemaDigest: string;
	ruleDigest: string;
	actionDigest: string;
	cast: Array<{ agentId: string; roleId: string; active: boolean }>;
	life: LifeDefinition;
	predicates: CompiledSocialPredicate[];
	variables: VariableDefinition[];
	definition: SocialDefinition;
};
export type SocialPolicyReference = {
	claim: ClaimRef;
	definitionRevision: number;
	projectionRevision: number;
	policyDigest: string;
};
export type SocialLimits = {
	maxOperations: number;
	maxBindings: number;
	maxDepth: number;
	maxBytes: number;
	maxHistoryEntries: number;
	maxTraceEntries: number;
};
export type SocialResolveInputV1 = {
	version: 1;
	requestId: string;
	world: WorldSnapshot;
	life: LifeState;
	identity: IdentityPolicySnapshot;
	checkpoint: EngineCheckpoint;
	rulePack: CompiledSocialPack;
	intent: SocialIntent;
	targetResponse: TargetResponse | null;
	simulationTime: number;
	bootstrap: SocialBootstrap | null;
	policies: SocialPolicyReference[];
	limits: SocialLimits;
};
export interface SocialAutonomyInput {
	stepId: string;
	worldRevision: number;
	lifeRevision: number;
	stateDigest: string;
	variables: Record<string, Scalar>;
}
export type SocialResolveInputV2 = Omit<SocialResolveInputV1, "version"> & {
	version: 2;
	autonomy: SocialAutonomyInput;
};
export type SocialResolveInput = SocialResolveInputV1 | SocialResolveInputV2;
export type SocialEffect =
	| {
			kind: "predicate";
			predicateId: string;
			firstAgentId: string;
			secondAgentId: string | null;
			previous: number | boolean;
			next: number | boolean;
	  }
	| { kind: "move"; agentId: string; sceneId: string }
	| { kind: "reveal"; fromAgentId: string; toAgentId: string; claim: ClaimRef }
	| { kind: "goal"; agentId: string; goalId: string; description: string };
export type SocialDecisionTrace = {
	rootActionId: string | null;
	terminalActionId: string | null;
	bindings: Record<string, string>;
	candidateIds: string[];
	triggerIds: string[];
	drawsBefore: number;
	drawsAfter: number;
	rejection: string | null;
};
type SocialResolutionBase = {
	version: 1;
	requestId: string;
	inputDigest: string;
	previousCheckpointDigest: string;
	resultDigest: string;
	trace: SocialDecisionTrace;
};
export type SocialResolution = SocialResolutionBase &
	(
		| {
				kind: "unchanged";
				outcome: "extension_required";
				effects: [];
				checkpoint: EngineCheckpoint;
		  }
		| {
				kind: "advanced";
				outcome: "accepted" | "rejected";
				effects: SocialEffect[];
				checkpoint: EnsembleCheckpoint;
		  }
	);
export type SocialActorView = {
	agentId: string;
	values: Array<{
		predicateId: string;
		firstAgentId: string;
		secondAgentId: string | null;
		value: number | boolean;
	}>;
	capabilities: Array<{
		id: string;
		description: string;
		primitives: SocialPrimitive["kind"][];
		rootActionId: string | null;
	}>;
};
export type SocialMigrationPreview = {
	version: 1;
	algorithm: "ensemble-migration-v1";
	fromPackVersion: number;
	toPackVersion: number;
	fromPackDigest: string;
	toPackDigest: string;
	previousCheckpointDigest: string;
	nextCheckpointDigest: string;
	worldRevision: number;
	lifeRevision: number;
	simulationTime: number;
	operations: Array<{
		kind:
			| "predicate_added"
			| "variable_added"
			| "agent_added"
			| "agent_retired"
			| "rules_rebuilt";
		id: string;
	}>;
	digest: string;
};
