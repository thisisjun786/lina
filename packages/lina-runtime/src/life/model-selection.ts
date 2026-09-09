import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import {
	type LifeModelSelection,
	parseLifeModelSelection,
} from "../../../lina-core/src/world/model-selection.ts";
import { resolveModelRoute } from "../models/routes.ts";
import type {
	ModelProfile,
	ModelSettings,
	ModelTier,
} from "../models/types.ts";

export type LifeModelSelector =
	| { provider: string; model: string }
	| { tier: ModelTier };

/** Explicit LIFE selectors never inherit a conversation or agent-role default. */
export function resolveLifeModelProfile(
	settings: ModelSettings,
	selector: LifeModelSelector,
): ModelProfile {
	if ("tier" in selector) {
		// An explicit tier bypasses role defaults and role reasoning overrides;
		// no agent scope is supplied. The role is only the non-conversation API gate.
		const route = resolveModelRoute(settings, "reflection", undefined, {
			tier: selector.tier,
		});
		if (!route) throw Error("LIFE model tier is not configured");
		return structuredClone(route.profile);
	}
	const matching = settings.profiles.filter(
		(profile) =>
			profile.provider === selector.provider &&
			profile.model === selector.model,
	);
	if (matching.length !== 1 || !matching[0])
		throw Error(
			"LIFE requires one explicit unambiguous model profile for its selected route",
		);
	return structuredClone(matching[0]);
}

/** Freeze the exact resolved settings, retaining an absent provider cap as null. */
export function freezeLifeModelSelection(
	settings: ModelSettings,
	selector: LifeModelSelector,
): LifeModelSelection {
	const profile = resolveLifeModelProfile(settings, selector);
	const selected = {
		profileId: profile.id,
		provider: profile.provider,
		model: profile.model,
		reasoning: profile.reasoning,
		maxOutputTokens: profile.maxOutputTokens ?? null,
		settingsRevision: settings.revision,
	};
	return parseLifeModelSelection({
		...selected,
		routeFingerprint: lifeDigest(selected),
	});
}
