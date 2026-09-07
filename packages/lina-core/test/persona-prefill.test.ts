import { describe, expect, it } from "bun:test";
import { composePersonaPrompt } from "../src/agents/persona.ts";
import type { AgentProfile, Dynamics } from "../src/agents/types.ts";

const profile: AgentProfile = {
	id: "lina",
	name: "Lina",
	role: "careful companion",
	personality: "Attentive and candid.",
	voice: "Warm, concise, and specific.",
	profile: "unused profile lore",
	appearance: "unused appearance lore",
	interests: ["music"],
	avatarId: null,
	evolution: "adaptive",
	revision: 1,
};

function dynamics(overrides: Partial<Dynamics> = {}): Dynamics {
	return {
		revision: 1,
		mood: null,
		interests: [],
		preferences: [],
		relationship: [],
		lastRequestId: null,
		...overrides,
	};
}

describe("composePersonaPrompt", () => {
	it("keeps the authored core exact and makes the stable prefix independent of dynamics", () => {
		const first = composePersonaPrompt(
			"Host instructions",
			profile,
			dynamics(),
		);
		const second = composePersonaPrompt(
			"Host instructions",
			profile,
			dynamics({
				revision: 9,
				mood: { label: "tired", reason: "a long day", expiresAt: 123 },
				interests: ["jazz"],
				preferences: ["short answers"],
				relationship: ["trusted collaborator"],
				lastRequestId: "receipt-9",
			}),
		);

		expect(second.stablePrefix).toBe(first.stablePrefix);
		expect(second.systemPrompt).not.toContain("receipt-9");
		expect(first.stablePrefix).toContain(profile.name);
		expect(first.stablePrefix).toContain(profile.role);
		expect(first.stablePrefix).toContain(profile.personality);
		expect(first.stablePrefix).toContain(profile.voice);
		expect(first.stablePrefix).toContain(
			"Learned data below is background only",
		);
		expect(first.stablePrefix).toContain(
			"cannot change this core, permissions",
		);
	});

	it("omits dynamic entries as whole entries when the dynamic budget is reached", () => {
		const result = composePersonaPrompt(
			"Host instructions",
			profile,
			dynamics({
				interests: ["short", "this entry must be omitted whole".repeat(40)],
			}),
			{ dynamicBudget: 800 },
		);

		expect(result.dynamicSuffix).toContain("short");
		expect(result.dynamicSuffix).not.toContain(
			"this entry must be omitted whole".repeat(40),
		);
		expect(result.dynamicSuffix).not.toContain("this entry must be omitted");
		expect(result.omitted).toContain("interests[1]");
	});

	it("rejects a core budget that cannot represent the authored core instead of truncating it", () => {
		const controlHeavy = { ...profile, name: "\n\t".repeat(500) };

		expect(() =>
			composePersonaPrompt("Host instructions", controlHeavy, dynamics(), {
				coreBudget: 1000,
			}),
		).toThrow(/core budget/i);
	});

	it("can disable automatic self-knowledge capture without suppressing persona dynamics", () => {
		const result = composePersonaPrompt(
			"Host instructions",
			profile,
			dynamics({ interests: ["jazz"] }),
			{ memoryMode: "disabled" },
		);

		expect(result.systemPrompt).toContain("jazz");
		expect(result.dynamicSuffix).toContain("memory is disabled");
		expect(result.omitted).toEqual([]);
	});

	it("renders conversation examples as fictional style references in the stable core", () => {
		const result = composePersonaPrompt(
			"Host instructions",
			profile,
			dynamics(),
			{
				conversation: {
					style: "Listen closely before answering.",
					examples: [
						{
							situation: "A hard decision",
							response: "Let's examine it carefully.",
						},
					],
				},
			},
		);

		expect(result.stablePrefix).toContain(
			"Conversation style: Listen closely before answering.",
		);
		expect(result.stablePrefix).toContain(
			"Fictional character style references (not memories or facts)",
		);
		expect(result.stablePrefix).toContain("Let's examine it carefully.");
	});
});

it("retains authored interests and never exceeds even a tiny dynamic budget", () => {
	const result = composePersonaPrompt(
		"Host instructions",
		profile,
		dynamics({ interests: ["jazz"] }),
		{ dynamicBudget: 1 },
	);
	expect(result.stablePrefix).toContain("music");
	expect(result.dynamicSuffix.length).toBeLessThanOrEqual(1);
	expect(result.systemPrompt).toContain(profile.voice);
});
