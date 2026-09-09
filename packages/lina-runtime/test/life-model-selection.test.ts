import { expect, test } from "bun:test";
import { resolveLifeModelProfile } from "../src/life/model-selection.ts";
import { MODEL_TIERS, type ModelSettings } from "../src/models/types.ts";

function settings(): ModelSettings {
	return {
		revision: 7,
		defaultProfileId: "conversation",
		profiles: [
			{
				id: "conversation",
				provider: "fixture",
				model: "chat",
				reasoning: "high",
			},
			{
				id: "life",
				provider: "fixture",
				model: "world",
				reasoning: "low",
				maxOutputTokens: 1024,
			},
		],
		roles: {},
		agentRoles: {},
		routes: {
			version: 1,
			roleTiers: {},
			tiers: {
				quick: { profileId: "life", reasoning: "off", maxOutputTokens: 128 },
				standard: { profileId: "life", reasoning: "low", maxOutputTokens: 256 },
				deep: { profileId: "life", reasoning: "medium", maxOutputTokens: 512 },
				intensive: {
					profileId: "life",
					reasoning: "high",
					maxOutputTokens: 768,
				},
			},
		},
	};
}
test("LIFE resolves all four explicit tiers including effort and output cap", () => {
	const saved = settings();
	for (const [index, tier] of MODEL_TIERS.entries()) {
		const selected = resolveLifeModelProfile(saved, { tier });
		expect(selected).toMatchObject({
			id: "life",
			provider: "fixture",
			model: "world",
			reasoning: ["off", "low", "medium", "high"][index],
			maxOutputTokens: [128, 256, 512, 768][index],
		});
	}
	expect(saved.profiles[1]?.reasoning).toBe("low");
});
test("LIFE exact selection preserves ambiguity rejection and never chooses conversation fallback", () => {
	const saved = settings();
	const selected = resolveLifeModelProfile(saved, {
		provider: "fixture",
		model: "world",
	});
	expect(selected.id).toBe("life");
	selected.reasoning = "off";
	expect(saved.profiles[1]?.reasoning).toBe("low");
	expect(() =>
		resolveLifeModelProfile(saved, { provider: "fixture", model: "missing" }),
	).toThrow("unambiguous");
	saved.profiles.push({
		id: "duplicate",
		provider: "fixture",
		model: "world",
		reasoning: "high",
	});
	expect(() =>
		resolveLifeModelProfile(saved, { provider: "fixture", model: "world" }),
	).toThrow("unambiguous");
	expect(resolveLifeModelProfile(saved, { tier: "deep" }).id).toBe("life");
});
test("LIFE rejects missing tier configuration instead of falling back", () => {
	const saved = settings();
	delete saved.routes;
	expect(() => resolveLifeModelProfile(saved, { tier: "quick" })).toThrow(
		"configured",
	);
});
