import { expect, test } from "bun:test";
import { validateReflectionGrowth } from "../src/world/growth.ts";
import { autonomySource } from "./life-autonomy-pure-fixture.ts";
import { required } from "./life-fixture.ts";

test("growth requires owned distinct evidence and respects policy before changes", () => {
	const s = autonomySource();
	s.life.worldRevision = 1;
	s.life.revision = 1;
	s.world.revision = 1;
	s.world.simulationTime = 1;
	s.life.experiences = [
		{
			id: "one",
			agentId: "lina",
			eventId: "test-world:1",
			channel: "inferred",
			claims: [],
			simulationTime: 1,
		},
		{
			id: "two",
			agentId: "lina",
			eventId: "test-world:1",
			channel: "inferred",
			claims: [],
			simulationTime: 1,
		},
	];
	const trait = {
		kind: "trait" as const,
		axisId: "axis",
		next: 1,
		evidenceIds: ["one"],
	};
	expect(validateReflectionGrowth(s, "lina", [trait])).toEqual([
		{ ...trait, agentId: "lina", previous: 0 },
	]);
	expect(() => validateReflectionGrowth(s, "mira", [trait])).toThrow(
		/evidence/i,
	);
	expect(() =>
		validateReflectionGrowth(s, "lina", [{ ...trait, next: 2 }]),
	).toThrow(/delta/i);
	expect(() =>
		validateReflectionGrowth(s, "lina", [
			{ kind: "habit", habitId: "habit", next: true, evidenceIds: ["one"] },
		]),
	).toThrow(/evidence/i);
	expect(() =>
		validateReflectionGrowth(s, "lina", [
			{
				kind: "habit",
				habitId: "habit",
				next: true,
				evidenceIds: ["one", "one"],
			},
		]),
	).toThrow();
	expect(
		validateReflectionGrowth(s, "lina", [
			{
				kind: "habit",
				habitId: "habit",
				next: true,
				evidenceIds: ["one", "two"],
			},
		]),
	).toHaveLength(1);
	required(s.identity.profiles[0]).lockedTraitIds = ["axis"];
	expect(validateReflectionGrowth(s, "lina", [trait])).toEqual([]);
	required(s.identity.profiles[0]).evolution = "manual";
	expect(
		validateReflectionGrowth(s, "lina", [
			{
				kind: "habit",
				habitId: "habit",
				next: true,
				evidenceIds: ["one", "two"],
			},
		]),
	).toEqual([]);
});

test("accepted trait and habit evidence changes the next deterministic opportunity score", async () => {
	const { applyLifeTransition } = await import(
		"../src/world/life-transition.ts"
	);
	const { transition } = await import("../src/world/transition.ts");
	const { lifeCommit } = await import("./life-fixture.ts");
	const { selectLifeEvent } = await import("../src/world/events.ts");
	const source = autonomySource(),
		commit = lifeCommit({
			experiences: [
				{
					id: "a",
					agentId: "lina",
					eventId: "test-world:1",
					channel: "direct",
					claims: [],
					simulationTime: 1,
				},
				{
					id: "b",
					agentId: "lina",
					eventId: "test-world:1",
					channel: "direct",
					claims: [],
					simulationTime: 1,
				},
			],
		});
	const staged = {
		...source,
		world: transition(source.world, commit.world),
		life: {
			...source.life,
			revision: 1,
			worldRevision: 1,
			experiences: commit.experiences,
		},
	};
	commit.growth = validateReflectionGrowth(staged, "lina", [
		{ kind: "trait", axisId: "axis", next: 1, evidenceIds: ["a"] },
		{ kind: "habit", habitId: "habit", next: true, evidenceIds: ["a", "b"] },
	]);
	const next = applyLifeTransition(
		source.life,
		source.world,
		staged.world,
		source.pack.life,
		commit,
		source.identity,
	);
	source.world = staged.world;
	source.life = next;
	source.autonomy.worldRevision = 1;
	source.autonomy.lifeRevision = 1;
	expect(
		required(
			selectLifeEvent(source, "next").candidates.find(
				(x) => x.agentId === "lina",
			),
		).weight,
	).toBe(24);
});
