import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import { parseLifeModelSelection } from "../src/world/model-selection.ts";

const fields = {
	profileId: "world",
	provider: "fixture",
	model: "deep",
	reasoning: "high" as const,
	maxOutputTokens: 512,
	settingsRevision: 4,
};
const selection = () => ({ ...fields, routeFingerprint: lifeDigest(fields) });
test("frozen LIFE selection round-trips exact effort, cap and settings", () => {
	expect(parseLifeModelSelection(selection())).toEqual(selection());
	const inherited = { ...fields, maxOutputTokens: null };
	expect(
		parseLifeModelSelection({
			...inherited,
			routeFingerprint: lifeDigest(inherited),
		}).maxOutputTokens,
	).toBeNull();
});
test("frozen LIFE selection rejects tampering and invalid independently fingerprinted values", () => {
	for (const patch of [
		{ reasoning: "low" },
		{ maxOutputTokens: 1024 },
		{ settingsRevision: 5 },
		{ profileId: "other" },
	])
		expect(() =>
			parseLifeModelSelection({ ...selection(), ...patch }),
		).toThrow();
	for (const patch of [
		{ reasoning: "extreme" },
		{ maxOutputTokens: 0 },
		{ settingsRevision: -1 },
		{ unexpected: true },
	]) {
		const altered = { ...fields, ...patch };
		expect(() =>
			parseLifeModelSelection({
				...altered,
				routeFingerprint: lifeDigest(altered),
			}),
		).toThrow();
	}
});
