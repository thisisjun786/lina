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
