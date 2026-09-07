import { expect, test } from "bun:test";
import { createPinnedEnsemble } from "../src/life/social/pinned.ts";

function fixture() {
	const engine = createPinnedEnsemble({ random: () => 0.25 });
	engine.api.init();
	engine.api.loadSocialStructure({
		schema: [
			{
				category: "feeling",
				types: ["closeness"],
				isBoolean: false,
				directionType: "directed",
				defaultValue: 0,
				minValue: 0,
				maxValue: 100,
				actionable: true,
			},
		],
	});
	engine.api.addCharacters({ cast: { hero: {}, love: {}, rival: {} } });
	const predicate = {
		category: "feeling",
		type: "closeness",
		first: "initiator",
		second: "responder",
	};
	engine.api.addActions({
		fileName: "fixture",
		actions: [
			{
				name: "other",
				intent: { ...predicate, intentType: true },
				conditions: [],
				influenceRules: [],
				leadsTo: ["wrong"],
			},
			{
				name: "chosen",
				intent: { ...predicate, intentType: true },
				conditions: [],
				influenceRules: [],
				leadsTo: ["group"],
			},
			{
				name: "group",
				conditions: [],
				influenceRules: [],
				leadsTo: ["yes", "no"],
			},
			{
				name: "yes",
				conditions: [],
				influenceRules: [],
				isAccept: true,
				effects: [{ ...predicate, operator: "+", value: 10 }],
			},
			{
				name: "no",
				conditions: [],
				influenceRules: [],
				isAccept: false,
				effects: [{ ...predicate, operator: "+", value: 2 }],
			},
			{
				name: "wrong",
				conditions: [],
				influenceRules: [],
				isAccept: true,
				effects: [{ ...predicate, operator: "+", value: 99 }],
			},
		],
	});
	return engine;
}

test("pinned root hierarchy preserves selected intent and explicit accept with negative volition", () => {
	const engine = fixture();
	const resolution = engine.resolveRoot(
		"chosen",
		"hero",
		"love",
		true,
		-30,
		["hero", "love", "rival"],
		100,
	);
	expect(resolution.candidateIds).toEqual(["yes"]);
	expect(resolution.action?.name).toBe("yes");
	if (!resolution.action) throw Error("missing terminal");
	engine.api.doAction(resolution.action);
	expect(
		engine.api.get({
			category: "feeling",
			type: "closeness",
			first: "hero",
			second: "love",
		})[0]?.value,
	).toBe(10);
	expect(
		engine.api.get({
			category: "feeling",
			type: "closeness",
			first: "love",
			second: "hero",
		})[0]?.value,
	).toBe(0);
});

test("pinned explicit reject wins over positive volition", () => {
	const result = fixture().resolveRoot(
		"chosen",
		"hero",
		"love",
		false,
		50,
		["hero", "love", "rival"],
		100,
	);
	expect(result.candidateIds).toEqual(["no"]);
	expect(result.action?.name).toBe("no");
});

test("full raw state hooks preserve counter, offstage, cache and future decisions", () => {
	const engine = fixture();
	engine.api.setCharacterOffstage("rival");
	engine.api.calculateVolition(["hero", "love", "rival"]);
	const state = engine.readState();
	const restored = fixture();
	restored.writeState(structuredClone(state));
	expect(restored.readState()).toEqual(state);
	expect(restored.definitions()).toEqual(engine.definitions());
	expect(
		restored.resolveRoot(
			"chosen",
			"hero",
			"love",
			true,
			0,
			["hero", "love"],
			100,
		),
	).toEqual(
		engine.resolveRoot(
			"chosen",
			"hero",
			"love",
			true,
			0,
			["hero", "love"],
			100,
		),
	);
});

test("explicit response has no hidden finite willingness threshold", () => {
	const result = fixture().resolveRoot(
		"chosen",
		"hero",
		"love",
		true,
		-1_000_000,
		["hero", "love", "rival"],
		100,
	);
	expect(result.action?.name).toBe("yes");
});

test("distribution source, compatibility helper and assembly match the explicit pinned manifest", async () => {
	const { readFileSync } = await import("node:fs");
	const { createHash } = await import("node:crypto");
	const { default: manifest } = await import(
		"../vendor/ensemble/manifest.json"
	);
	expect(manifest.revision).toBe("8b74bdec4ba2ef4e14795b7591df3b5d73f283e3");
	expect(manifest.modules).toHaveLength(7);
	for (const item of [
		...manifest.modules,
		manifest.compatibility,
		manifest.assembly,
		manifest.license,
	]) {
		const data = readFileSync(
			new URL(`../vendor/ensemble/${item.file}`, import.meta.url),
		);
		expect(createHash("sha256").update(data).digest("hex")).toBe(item.sha256);
	}
});
