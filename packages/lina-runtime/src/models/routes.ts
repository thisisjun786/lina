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
	if (role === "conversation") {
		const profile = resolveProfile(
			settings,
			role,
			agentId,
			request?.overrideProfileId,
		);
		return profile
			? {
					mode:
						request?.overrideProfileId === undefined ? "legacy" : "override",
					settingsRevision: settings.revision,
					profile,
				}
			: null;
	}
	if (request?.overrideProfileId !== undefined)
		throw new ModelRequestError(
			"Internal engine models must use a shared tier",
			"invalid_input",
		);
	if (!settings.routes)
		throw new ModelRequestError(
			"No model routes are configured",
			"not_configured",
		);
	const tier = request?.tier ?? settings.routes.roleTiers[role];
	if (tier === undefined)
		throw new ModelRequestError(
			"No model tier is configured for the " + role + " role",
			"not_configured",
		);
	validModelTier(tier);
	const binding = settings.routes.tiers[tier];
	const selected = settings.profiles.find(
		(profile) => profile.id === binding.profileId,
	);
	if (!selected)
		throw new ModelRequestError("Unknown tier profile", "not_configured");
	const profile = { ...selected };
	if (binding.reasoning !== undefined) profile.reasoning = binding.reasoning;
	if (binding.maxOutputTokens !== undefined)
		profile.maxOutputTokens = binding.maxOutputTokens;
	return { mode: "tier", settingsRevision: settings.revision, tier, profile };
}
