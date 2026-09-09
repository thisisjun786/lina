import type { LifeConfigInput } from "../../../lina-core/src/world/authoring-types.ts";

/** Readiness reports authored omissions; it does not fill values or start work. */
export function lifeConfigReadiness(config: LifeConfigInput) {
	const missing: string[] = [];
	for (const group of ["clock", "run", "models", "limits", "usage"] as const)
		if (config[group] === null) missing.push(group);
	if (
		config.run?.mode === "automatic" &&
		config.clock &&
		config.clock.intervalMs === null
	)
		missing.push("clock.intervalMs");
	if (config.models) {
		if (!config.models.actor) missing.push("models.actor");
		if (!config.models.director) missing.push("models.director");
	}
	return {
		status: missing.length
			? ("not_configured" as const)
			: ("configured" as const),
		automaticReady: missing.length === 0 && config.run?.mode === "automatic",
		missing,
	};
}
