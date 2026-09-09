import { expect, test } from "bun:test";
import { parseWorldPack } from "../src/world/authoring-validation.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import { socialPack } from "./life-social-pack-fixture.ts";

function population(agents: number, predicates: number, directed = true) {
	const pack = socialPack(),
		members = Array.from({ length: agents }, (_, n) => `agent-${n}`);
	pack.world.agents = members;
	pack.world.scenes = [
		{
			id: "meeting",
			placeId: "garden",
			description: "An authored scene",
			occupants: members.slice(0, 2),
		},
	];
	pack.world.lore = [];
	pack.life.participants = members;
	pack.life.traits = [];
	pack.life.habits = [];
	pack.life.attitudes = [];
	pack.life.projection = {
		revision: 1,
		sharedTraitIds: [],
		sharedHabitIds: [],
		sharedAttitudeIds: [],
		disclosures: [],
	};
	pack.roles = members.map((agentId) => ({
		agentId,
		roleId: "resident",
		status: "active",
		description: "A synthetic resident",
	}));
	pack.variables = [];
	pack.predicates = Array.from({ length: predicates }, (_, n) => ({
		id: `predicate-${n}`,
		type: "number",
		direction: directed ? "directed" : "undirected",
		initial: 0,
		min: -2,
		max: 2,
	}));
	pack.social = {
		version: 1,
		actions: [],
		triggers: [],
		volitions: [],
		capabilities: [],
		policies: pack.predicates.map((p) => ({
			predicateId: p.id,
			duration: null,
			visibility: { kind: "public" },
			resource: false,
			attitudeAxisId: null,
		})),
	};
	return pack;
}

test("a small serialized definition cannot request millions of social cells", () => {
	const pack = population(256, 100);
	expect(Buffer.byteLength(JSON.stringify(pack))).toBeLessThan(1_000_000);
	expect(() => {
		parseWorldPack(pack);
	}).toThrow(/capacity/i);
	expect(() => {
		compileSocialPack(pack);
	}).toThrow(/capacity/i);
});

test("compiler capacity includes initial and advanced history and empty-schema cache pairs", () => {
	expect(() => compileSocialPack(population(66, 1))).toThrow(/capacity/i);
	expect(() => compileSocialPack(population(65, 0))).toThrow(/capacity/i);
	expect(compileSocialPack(population(45, 1)).cast).toHaveLength(45);
	expect(() => compileSocialPack(population(46, 1))).toThrow(/capacity/i);
	expect(compileSocialPack(population(64, 32, false)).predicates).toHaveLength(
		32,
	);
});
