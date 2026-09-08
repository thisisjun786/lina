import { expect, test } from "bun:test";
import {
	SHARED_PERSONA_AUTHORITY,
	sharedPersonaBehavior,
} from "../src/agents/persona.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { projectSharedPersona } from "../src/world/views.ts";
import { pureStep } from "./life-autonomy-pure-fixture.ts";

test("NPC and ordinary persona use the same permitted current behavior and authored identity", () => {
	const step = pureStep(),
		source = step.source;
	step.version = 2;
	const agentId = step.decision.agentId;
	if (!agentId) throw Error("Missing actor");
	const profile = source.profiles.find((p) => p.id === agentId);
	if (!profile) throw Error("Missing profile");
	const growth = projectSharedPersona(
		source.life,
		source.pack.life,
		{
			version: 1,
			agentId,
			revision: 1,
			worldId: step.worldId,
			projectionPolicyRevision: source.pack.life.projection.revision,
		},
		source.identity,
		{ maxChars: 10000, maxRecords: 20 },
	);
	const built = buildLifeModelInput(step, "director", agentId);
	expect(JSON.parse(built.input).sharedPersona).toEqual(
		sharedPersonaBehavior(profile, growth),
	);
	expect(built.systemPrompt).toContain(SHARED_PERSONA_AUTHORITY);
	expect(JSON.parse(built.input).identity).toMatchObject({
		name: profile.name,
		profile: profile.profile,
		appearance: profile.appearance,
	});
});
