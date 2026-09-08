import { ModelRequestError } from "./errors.ts";
import { resolveProfile } from "./selection.ts";
import type {
	ModelProfile,
	ModelRole,
	ModelRouteRequest,
	ModelSettings,
	ModelTier,
} from "./types.ts";
import { validModelRole, validModelTier } from "./validation.ts";

export interface ModelRouteResult {
	mode: "legacy" | "tier" | "override";
	settingsRevision: number;
	tier?: ModelTier;
	profile: ModelProfile;
}

/** Resolve a validated settings snapshot; never invent a provider or fallback. */
export function resolveModelRoute(
	settings: ModelSettings,
	role: ModelRole,
	agentId?: string,
	request?: ModelRouteRequest,
): ModelRouteResult | null {
	validModelRole(role);
	if (request?.tier !== undefined && request.overrideProfileId !== undefined)
		throw new ModelRequestError(
			"Tier and profile override are mutually exclusive",
			"invalid_input",
		);
	if (role === "conversation" && request?.tier !== undefined)
		throw new ModelRequestError(
			"Conversation cannot use model tiers",
			"invalid_input",
		);
	const legacy = resolveProfile(
		settings,
		role,
		agentId,
		request?.overrideProfileId,
	);
	if (request?.overrideProfileId !== undefined)
		return legacy
			? {
					mode: "override",
					settingsRevision: settings.revision,
					profile: legacy,
				}
			: null;
	const agentBound =
		agentId !== undefined &&
		Object.hasOwn(settings.agentRoles, agentId) &&
		Object.hasOwn(settings.agentRoles[agentId] ?? {}, role);
	const tier =
		request?.tier ??
		(role !== "conversation" && !agentBound
			? settings.routes?.roleTiers[role]
			: undefined);
	if (tier === undefined)
		return legacy
			? { mode: "legacy", settingsRevision: settings.revision, profile: legacy }
			: null;
	validModelTier(tier);
	if (!settings.routes)
		throw new ModelRequestError(
			"No model routes are configured",
			"not_configured",
		);
	const binding = settings.routes.tiers[tier];
	const selected = settings.profiles.find(
		(profile) => profile.id === binding.profileId,
	);
	if (!selected)
		throw new ModelRequestError("Unknown tier profile", "not_configured");
	const profile = { ...selected };
	if (binding.reasoning !== undefined) profile.reasoning = binding.reasoning;
	const agentReasoning =
		agentId !== undefined &&
		settings.agentRoleReasoning &&
		Object.hasOwn(settings.agentRoleReasoning, agentId)
			? settings.agentRoleReasoning[agentId]
			: undefined;
	if (
		request?.tier === undefined &&
		agentReasoning &&
		Object.hasOwn(agentReasoning, role) &&
		agentReasoning[role] !== undefined
	)
		profile.reasoning = agentReasoning[role];
	if (binding.maxOutputTokens !== undefined)
		profile.maxOutputTokens = binding.maxOutputTokens;
	return { mode: "tier", settingsRevision: settings.revision, tier, profile };
}
