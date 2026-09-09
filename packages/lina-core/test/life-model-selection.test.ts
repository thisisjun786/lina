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

test("world config v2 accepts explicit four-tier selectors and rejects ambiguous routes", async () => {
	const { parseLifeConfigInput } = await import(
		"../src/world/authoring-request-validation.ts"
	);
	const { autonomySource } = await import("./life-autonomy-pure-fixture.ts");
	const {
		worldId: _id,
		revision: _revision,
		...base
	} = autonomySource().config;
	for (const tier of ["quick", "standard", "deep", "intensive"] as const) {
		const input = {
			...base,
			version: 2,
			work: null,
			models: { director: { tier }, actor: { tier } },
		};
		expect(parseLifeConfigInput(input).models).toEqual(input.models);
	}
	expect(() =>
		parseLifeConfigInput({
			...base,
			version: 2,
			work: null,
			models: { director: { tier: "unknown" }, actor: null },
		}),
	).toThrow();
	expect(() =>
		parseLifeConfigInput({
			...base,
			version: 2,
			work: null,
			models: {
				director: { tier: "quick", provider: "provider", model: "model" },
				actor: null,
			},
		}),
	).toThrow();
	expect(() =>
		parseLifeConfigInput({
			...base,
			models: { director: { tier: "quick" }, actor: null },
		}),
	).toThrow();
});
