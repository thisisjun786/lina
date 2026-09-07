import type {
	DisclosurePolicy,
	LifeDefinition,
	LifeViewLimits,
} from "./life-types.ts";
import type {
	SocialDefinition,
	SocialMigrationPreview,
} from "./social-types.ts";
import type { WorldDefinition } from "./types.ts";

export type Scalar = string | number | boolean;
export type Expression =
	| { op: "literal"; value: Scalar }
	| { op: "read"; variableId: string }
	| { op: "random"; id: string; min: number; max: number }
	| { op: "not"; value: Expression }
	| { op: "all" | "any"; items: Expression[] }
	| {
			op:
				| "eq"
				| "ne"
				| "lt"
				| "lte"
				| "gt"
				| "gte"
				| "add"
				| "sub"
				| "mul"
				| "div";
			left: Expression;
			right: Expression;
	  };
export type TextPart =
	| { kind: "text"; text: string }
	| { kind: "value"; expression: Expression };
export type AgentReference =
	| { kind: "actor" }
	| { kind: "target" }
	| { kind: "agent"; agentId: string };
export type VariableDefinition = {
	id: string;
	type: "string" | "number" | "boolean";
	initial: Scalar;
	min: number | null;
	max: number | null;
	knownTo: string[];
};
export type PredicateDefinition = {
	id: string;
	type: "number" | "boolean";
	direction: "directed" | "reciprocal" | "undirected";
	initial: number | boolean;
	min: number | null;
	max: number | null;
};
export type RuleEffect =
	| { kind: "assign"; variableId: string; value: Expression }
	| {
			kind: "event";
			familyId: string;
			actorIds: AgentReference[];
			summary: TextPart[];
	  }
	| { kind: "fact"; id: string; text: TextPart[]; knownTo: AgentReference[] }
	| {
			kind: "attitude";
			from: AgentReference;
			to: AgentReference;
			axisId: string;
			delta: Expression;
	  }
	| {
			kind: "goal";
			agent: AgentReference;
			id: string;
			description: TextPart[];
	  };
export type EvaluatedEffect =
	| { kind: "assign"; variableId: string; value: Scalar }
	| { kind: "event"; familyId: string; actorIds: string[]; summary: string }
	| { kind: "fact"; id: string; text: string; knownTo: string[] }
	| {
			kind: "attitude";
			fromAgentId: string;
			toAgentId: string;
			axisId: string;
			delta: number;
	  }
	| { kind: "goal"; agentId: string; id: string; description: string };
export type DeclarativeRule = {
	id: string;
	condition: Expression;
	probability: number;
	priority: number;
	knownTo: string[];
	effects: RuleEffect[];
};
export type LoreEntry = {
	id: string;
	sourceId: string;
	primaryKeys: string[];
	secondaryKeys: string[];
	secondaryMode: "any" | "all";
	always: boolean;
	recursive: boolean;
	condition: Expression;
	probability: number;
	priority: number;
	placement: "before" | "after";
	text: TextPart[];
	disclosure: DisclosurePolicy;
	effects: RuleEffect[];
};
export type EventFamily = {
	id: string;
	description: string;
	actorRoleIds: string[];
	condition: Expression;
	weight: number;
	effects: RuleEffect[];
};
export type WorldRole = {
	agentId: string;
	roleId: string;
	description: string;
	status: "active" | "retired";
};
export type WorldConstraint = {
	id: string;
	description: string;
	condition: Expression;
};
export type AuthoringQuestion = {
	id: string;
	question: string;
	blocking: boolean;
};
export type ImportReport = {
	sourceId: string;
	reason: string;
	rawJson: string;
};
export type WorldPackV1 = {
	schemaVersion: 1;
	worldId: string;
	version: number;
	background: {
		authoredText: string;
		era: string | null;
		environment: string | null;
		description: string | null;
	};
	world: WorldDefinition;
	life: LifeDefinition;
	constraints: WorldConstraint[];
	roles: WorldRole[];
	variables: VariableDefinition[];
	predicates: PredicateDefinition[];
	lore: LoreEntry[];
	rules: DeclarativeRule[];
	eventFamilies: EventFamily[];
	unresolved: AuthoringQuestion[];
	importReport: ImportReport[];
};
export type WorldPackV2 = Omit<WorldPackV1, "schemaVersion"> & {
	schemaVersion: 2;
	social: SocialDefinition;
};
export type WorldPack = WorldPackV1 | WorldPackV2;
export type EvaluationLimits = LifeViewLimits & {
	maxDepth: number;
	maxOperations: number;
};
export type EvaluationInput = {
	worldId: string;
	agentId: string;
	targetAgentId: string | null;
	recipientId: string | null;
	evaluationId: string;
	seed: string;
	text: string;
	variables: Record<string, Scalar>;
	limits: EvaluationLimits;
};
export type RandomDraw = { id: string; value: number };
export type EvaluationReceipt = {
	version: 1;
	worldId: string;
	agentId: string;
	recipientId: string | null;
	evaluationId: string;
	inputDigest: string;
	seed: string;
	entries: Array<{
		id: string;
		sourceId: string;
		placement: "before" | "after";
		text: string;
	}>;
	ruleIds: string[];
	effects: EvaluatedEffect[];
	variables: Record<string, Scalar>;
	draws: RandomDraw[];
	truncated: boolean;
	digest: string;
};
export type ImportedWorldData = {
	lore: LoreEntry[];
	rules: DeclarativeRule[];
	report: ImportReport[];
};

export type LifeConfigInput = {
	version: 1;
	clock: {
		stepSize: number;
		intervalMs: number | null;
		maxCatchUpSteps: number;
	} | null;
	run: { mode: "paused" | "manual" | "automatic" } | null;
	models: {
		director: { provider: string; model: string } | null;
		actor: { provider: string; model: string } | null;
	} | null;
	limits: {
		maxActorActions: number;
		maxCausalDepth: number;
		maxModelCalls: number;
		evaluation: EvaluationLimits;
	} | null;
	usage: {
		windowMs: number;
		maxInputTokens: number;
		maxOutputTokens: number;
		maxImages: number;
	} | null;
	publication: { mode: "manual" | "automatic"; recipientIds: string[] } | null;
	images: { mode: "manual" | "automatic"; maxPerStep: number } | null;
	avatars: {
		mode: "manual" | "automatic";
		intervalMs: number | null;
		maxPerWindow: number;
	} | null;
};
export type LifeConfig = LifeConfigInput & {
	worldId: string;
	revision: number;
};
export type WorldDraftInput = { worldId: string; authoredText: string };
export type WorldDraftPatch = { authoredText: string; pack: WorldPack | null };
export type SuggestionProvenance = {
	requestId: string;
	provider: string;
	model: string;
	inputDigest: string;
};
export type WorldDraft = {
	version: 1;
	id: string;
	worldId: string;
	revision: number;
	baseWorldVersion: number | null;
	baseWorldRevision: number | null;
	authoredText: string;
	pack: WorldPack | null;
	suggestion: SuggestionProvenance | null;
	unresolved: AuthoringQuestion[];
	digest: string;
};
export type WorldDraftCursor = { afterId: string | null; limit: number };
export type WorldDraftPage = { items: WorldDraft[]; nextCursor: string | null };
export type WorldCatalogPage = {
	items: Array<{
		worldId: string;
		title: string;
		version: number;
		worldRevision: number;
		packVersion: number | null;
	}>;
	nextCursor: string | null;
};
export type WorldPreviewOptions = {
	expectedWorldRevision: number | null;
	simulationTime: number;
	agentId: string;
	targetAgentId: string | null;
	seed: string;
	limits: EvaluationLimits;
	relocations: Array<{ agentId: string; sceneId: string | null }>;
};
export type WorldDraftPreviewV1 = {
	version: 1;
	draftId: string;
	draftRevision: number;
	worldId: string;
	packDigest: string | null;
	options: WorldPreviewOptions;
	unresolved: AuthoringQuestion[];
	changes: {
		addedAgents: string[];
		retiredAgents: string[];
		removedScenes: string[];
		changedPlaces: string[];
		changedRuleIds: string[];
	};
	evaluation: EvaluationReceipt | null;
	canActivate: boolean;
	digest: string;
};
export type WorldDraftPreviewV2 = Omit<WorldDraftPreviewV1, "version"> & {
	version: 2;
	socialMigration: SocialMigrationPreview | null;
};
export type WorldDraftPreview = WorldDraftPreviewV1 | WorldDraftPreviewV2;
export type WorldConfirmation = {
	draftId: string;
	expectedRevision: number;
	idempotencyKey: string;
	packDigest: string;
	previewDigest: string;
	options: WorldPreviewOptions;
};
export type WorldActivationReceiptV1 = {
	version: 1;
	worldId: string;
	worldVersion: number;
	worldRevision: number;
	lifeRevision: number;
	draftId: string;
	draftRevision: number;
	eventId: string | null;
	inputDigest: string;
	preview: WorldDraftPreviewV1;
	replayed: boolean;
};
export type WorldActivationReceiptV2 = Omit<
	WorldActivationReceiptV1,
	"version" | "preview"
> & { version: 2; preview: WorldDraftPreviewV2 };
export type WorldActivationReceipt =
	| WorldActivationReceiptV1
	| WorldActivationReceiptV2;
export type WorldAuthorGrant = {
	version: 1;
	id: string;
	worldId: string;
	agentId: string;
	revision: number;
	status: "active" | "revoked";
};
export type WorldAuthorScope =
	| { grantId: string; grantRevision: number }
	| { kind: "management" };
export type WorldSuggestionRequest = {
	requestId: string;
	draftId: string;
	draftRevision: number;
	agentId: string;
	modelSettingsRevision: number;
};
export type WorldSuggestionContent =
	| { pack: WorldPack }
	| { pack: null; unresolved: AuthoringQuestion[] };
export type WorldSuggestionResult = WorldSuggestionContent & {
	provider: string;
	model: string;
};
export type WorldSuggestion = {
	version: 1;
	input: WorldSuggestionRequest;
	inputDigest: string;
	scope: WorldAuthorScope;
	status:
		| "prepared"
		| "dispatched"
		| "unknown"
		| "succeeded"
		| "failed"
		| "abandoned";
	result: { draft: WorldDraft; provider: string; model: string } | null;
	error: "invalid_result" | "stale" | "revoked" | "dispatch_unknown" | null;
};

/** Trusted application consumer. Scope comes from management or a persisted author grant, never tool arguments. */
export interface WorldAuthoringPort {
	draftWorld(input: WorldDraftInput, scope?: WorldAuthorScope): WorldDraft;
	worldDraft(draftId: string, scope?: WorldAuthorScope): WorldDraft;
	worldDrafts(
		cursor: WorldDraftCursor,
		scope?: WorldAuthorScope,
	): WorldDraftPage;
	worldCatalog(
		cursor: WorldDraftCursor,
		scope?: WorldAuthorScope,
	): WorldCatalogPage;
	editWorldDraft(
		draftId: string,
		expectedRevision: number,
		patch: WorldDraftPatch,
		scope?: WorldAuthorScope,
	): WorldDraft;
	previewWorldDraft(
		draftId: string,
		expectedRevision: number,
		options: WorldPreviewOptions,
		scope?: WorldAuthorScope,
	): WorldDraftPreview;
	activateWorldDraft(
		confirmation: WorldConfirmation,
		scope?: WorldAuthorScope,
	): WorldActivationReceipt;
	worldPack(
		worldId: string,
		version?: number,
		scope?: WorldAuthorScope,
	): WorldPack;
	lifeConfig(worldId: string, scope?: WorldAuthorScope): LifeConfig;
	setLifeConfig(
		worldId: string,
		expectedRevision: number,
		config: LifeConfigInput,
		scope?: WorldAuthorScope,
	): LifeConfig;
	grantWorldAuthor(worldId: string, agentId: string): WorldAuthorGrant;
	worldAuthorGrant(grantId: string): WorldAuthorGrant;
	revokeWorldAuthor(
		grantId: string,
		expectedRevision: number,
	): WorldAuthorGrant;
	prepareWorldSuggestion(
		input: WorldSuggestionRequest,
		scope?: WorldAuthorScope,
	): WorldSuggestion;
	worldSuggestion(requestId: string, scope?: WorldAuthorScope): WorldSuggestion;
	dispatchWorldSuggestion(
		requestId: string,
		scope?: WorldAuthorScope,
	): { request: WorldSuggestion; dispatched: boolean };
	finishWorldSuggestion(
		requestId: string,
		result: WorldSuggestionResult,
		scope?: WorldAuthorScope,
	): WorldSuggestion;
	failWorldSuggestion(
		requestId: string,
		reason: "invalid_result" | "stale" | "revoked" | "dispatch_unknown",
		scope?: WorldAuthorScope,
	): WorldSuggestion;
	abandonWorldSuggestion(
		requestId: string,
		scope?: WorldAuthorScope,
	): WorldSuggestion;
}
