import { expect, test } from "bun:test";
import type { WorldPackV2 } from "../src/world/authoring-types.ts";
import { parseWorldPack } from "../src/world/authoring-validation.ts";
import { initialLifeState } from "../src/world/life-transition.ts";
import type { LifeCommitV2, LifeStateV2 } from "../src/world/life-types.ts";
import {
	parseLifeCommit,
	parseLifeState,
} from "../src/world/life-validation.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { authoringPack } from "./life-authoring-fixture.ts";
import { lifeCommit, lifeDefinition } from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

test("explicit social pack encoding round trips without rewriting a legacy pack", () => {
	const legacy = parseWorldPack(authoringPack());
	const before = JSON.stringify(parseWorldPack(legacy));
	const input: WorldPackV2 = {
		...legacy,
		schemaVersion: 2,
		social: {
			version: 1,
			policies: [],
			triggers: [],
			volitions: [],
			actions: [],
			capabilities: [],
		},
	};
	expect(parseWorldPack(JSON.parse(JSON.stringify(input)))).toEqual(input);
	expect(JSON.stringify(parseWorldPack(legacy))).toBe(before);
	expect(() => parseWorldPack({ ...input, schemaVersion: 1 })).toThrow();
	expect(() => parseWorldPack({ ...input, schemaVersion: 3 })).toThrow();
});

test("knowledge-capable state decoding retains an exact legacy encoding", () => {
	const legacy = initialLifeState(
		initialSnapshot(worldDefinition()),
		lifeDefinition(),
	);
	const before = JSON.stringify(parseLifeState(legacy));
	const current: LifeStateV2 = { ...legacy, version: 2, knowledgeGrants: [] };
	expect(parseLifeState(JSON.parse(JSON.stringify(current)))).toEqual(current);
	expect(JSON.stringify(parseLifeState(legacy))).toBe(before);
	expect(() => parseLifeState({ ...legacy, version: 2 })).toThrow();
	expect(() => parseLifeState({ ...current, version: 1 })).toThrow();
});

test("social commit decoding requires an explicit resolution reference", () => {
	const legacy = lifeCommit();
	const current: LifeCommitV2 = {
		...legacy,
		version: 2,
		socialResolutionId: "resolution-1",
		knowledgeGrants: [],
	};
	expect(parseLifeCommit(JSON.parse(JSON.stringify(current)))).toEqual(current);
	expect(parseLifeCommit(legacy)).toEqual(legacy);
	expect(() => parseLifeCommit({ ...legacy, version: 2 })).toThrow();
	expect(() => parseLifeCommit({ ...current, version: 1 })).toThrow();
});
