export const MODEL_ROLES = [
	"conversation",
	"summary",
	"observation",
	"reflection",
	"recall",
	"vision",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelReasoning = "off" | "low" | "medium" | "high";

export const MODEL_TIERS = ["quick", "standard", "deep", "intensive"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export interface ModelTierBinding {
	profileId: string;
	reasoning?: ModelReasoning;
	maxOutputTokens?: number;
}
export interface ModelRoutes {
	version: 1;
	tiers: Record<ModelTier, ModelTierBinding>;
	roleTiers: Partial<Record<Exclude<ModelRole, "conversation">, ModelTier>>;
}
export interface ModelRouteRequest {
	tier?: ModelTier;
	overrideProfileId?: string;
}

/** Public selection options only; native provider configuration owns auth/URLs. */
export interface ModelProfile {
	id: string;
	provider: string;
	model: string;
	reasoning: ModelReasoning;
	/** Omitted: the native provider's configured maxTokens for the model applies. */
	maxOutputTokens?: number;
}

/** Desired reasoning per role, independent of which profile a role resolves to. */
export type RoleReasoning = Partial<Record<ModelRole, ModelReasoning>>;

export interface ModelSettings {
	routes?: ModelRoutes;
	revision: number;
	profiles: ModelProfile[];
	defaultProfileId: string | null;
	roles: Partial<Record<ModelRole, string>>;
	agentRoles: Record<string, Partial<Record<ModelRole, string>>>;
	/** Optional for legacy JSON; absent keys are never written back. */
	roleReasoning?: RoleReasoning;
	agentRoleReasoning?: Record<string, RoleReasoning>;
}

/** A full replacement. The store alone advances the saved revision. */
export type ModelSettingsInput = Omit<ModelSettings, "revision">;
