import type { LifeConfigInput } from "../../../lina-core/src/world/authoring-types.ts";

/** Readiness reports authored omissions; it does not fill values or start work. */
export function lifeConfigReadiness(config: LifeConfigInput) {
	const missing: string[] = [];
	for (const group of [
		"clock",
		"run",
		"models",
		"limits",
		"usage",
		"publication",
		"images",
		"avatars",
	] as const)
		if (config[group] === null) missing.push(group);
	if (config.clock && config.clock.intervalMs === null)
		missing.push("clock.intervalMs");
	if (config.models) {
		if (!config.models.actor) missing.push("models.actor");
		if (!config.models.director) missing.push("models.director");
	}
	if (
		config.avatars?.mode === "automatic" &&
		config.avatars.intervalMs === null
	)
		missing.push("avatars.intervalMs");
	return {
		status: missing.length
			? ("not_configured" as const)
			: ("configured" as const),
		automaticReady: missing.length === 0 && config.run?.mode === "automatic",
		missing,
	};
}
