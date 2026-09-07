import { OpenCodexHub } from "../../packages/lina-opencodex/src/index.ts";
import type { ModelSettings } from "../../packages/lina-runtime/src/models/types.ts";

const hub = new OpenCodexHub();
await hub.refresh();
const profile = {
	id: "probe",
	provider: "opencodex",
	model: "gpt-5.6-sol",
	reasoning: "off" as const,
};
const settings: ModelSettings = {
	revision: 1,
	profiles: [profile],
	defaultProfileId: "probe",
	roles: {},
	agentRoles: {},
};
const models = hub.createModelControl(() => settings);
const records: unknown[] = [
	{
		step: "catalog",
		status: hub.status(),
		matched: hub.catalog().find((m) => m.id === profile.model),
	},
];
try {
	const trial = await models.test(
		profile,
		"Reply with exactly LINA_SERVICE_OK.",
		AbortSignal.timeout(30000),
	);
	records.push({ step: "trial", ...trial });
	const services = hub.createContextServices(() => settings);
	const summary = await services.summarize(
		"User on Monday: use blue for the project. User correction on Tuesday: use green instead of blue. Outstanding: choose a launch date. Preserve the correction and outstanding item.",
		512,
		AbortSignal.timeout(30000),
	);
	records.push({ step: "summary", summary });
} catch (error) {
	records.push({
		step: "error",
		error: error instanceof Error ? error.message : "unknown",
	});
	process.exitCode = 1;
}
await Bun.write(
	new URL(
		"../../devlog/_plan/260906_codex_runtime/041_hub_live.json",
		import.meta.url,
	),
	JSON.stringify(records, null, 2) + "\n",
);
console.log(JSON.stringify(records));
