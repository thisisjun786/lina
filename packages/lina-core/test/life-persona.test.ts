import { expect, test } from "bun:test";
import {
	composePersonaPrompt,
	sharedPersonaBehavior,
} from "../src/agents/persona.ts";
import type { AgentProfile } from "../src/agents/types.ts";
import { emptyDynamics } from "../src/agents/validation.ts";
import type { SharedPersonaView } from "../src/world/life-types.ts";

const profile: AgentProfile = {
	id: "lina",
	name: "Lina",
	role: "companion",
	personality: "Initially reserved",
	voice: "Warm concise voice",
	profile: "Authored identity anchor",
	appearance: "Authored appearance",
	interests: ["books"],
	evolution: "adaptive",
	revision: 1,
	avatarId: null,
};
const growth: SharedPersonaView = {
	version: 1,
	worldId: "test-world",
	agentId: "lina",
	lifeRevision: 3,
	bindingRevision: 1,
	projectionPolicyRevision: 1,
	profileRevision: 1,
	traits: [{ label: "Sociability", value: 7 }],
	habits: [{ label: "Greets friends", value: true }],
	attitudes: [{ toAgentId: "mira", label: "Trust", value: 4 }],
	truncated: false,
};
test("ordinary and NPC persona use one authority for current adaptable behavior while retaining complete authored identity", () => {
	const view = sharedPersonaBehavior(profile, growth);
	const first = composePersonaPrompt("host", profile, emptyDynamics(), {
		sharedGrowth: growth,
	});
	const changed = composePersonaPrompt("host", profile, emptyDynamics(), {
		sharedGrowth: { ...growth, traits: [{ label: "Sociability", value: 1 }] },
	});
	for (const text of [
		profile.name,
		profile.role,
		profile.personality,
		profile.voice,
		profile.profile,
		profile.appearance,
	])
		expect(first.systemPrompt).toContain(text);
	expect(first.systemPrompt).toContain(view.authority);
	expect(first.systemPrompt).toContain('"Sociability","value":7');
	expect(changed.systemPrompt).toContain('"Sociability","value":1');
	expect(first.systemPrompt).toContain("governs adaptable behavior");
	expect(first.systemPrompt).toContain("explicit locks");
	expect(first.stablePrefix).toBe(changed.stablePrefix);
});
test("growth projection never serializes private causes and refuses stale or foreign identity", () => {
	const first = composePersonaPrompt("", profile, emptyDynamics(), {
		sharedGrowth: {
			...growth,
			privateCause: "PRIVATE_SECRET",
		} as SharedPersonaView,
	});
	expect(first.systemPrompt).not.toContain("PRIVATE_SECRET");
	expect(first.systemPrompt).not.toContain("test-world");
	expect(() =>
		sharedPersonaBehavior(profile, { ...growth, profileRevision: 2 }),
	).toThrow(/identity|revision/i);
	expect(() =>
		sharedPersonaBehavior(profile, { ...growth, agentId: "other" }),
	).toThrow(/identity|agent/i);
	expect(
		sharedPersonaBehavior({ ...profile, evolution: "manual" }, growth).traits,
	).toEqual([]);
	expect(() =>
		sharedPersonaBehavior(profile, {
			...growth,
			traits: [{ label: "axis", value: Infinity }],
		}),
	).toThrow();
});
