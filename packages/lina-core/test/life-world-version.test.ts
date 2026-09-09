import { expect, test } from "bun:test";
import { migrateLifeDefinition } from "../src/world/life-definition.ts";
import {
	applyLifeTransition,
	initialLifeState,
} from "../src/world/life-transition.ts";
import { initialSnapshot, transition } from "../src/world/transition.ts";
import { parseProposal } from "../src/world/validation.ts";
import {
	identityPolicy,
	lifeDefinition,
	required,
	socialCommit,
} from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

function change() {
	const definition = worldDefinition();
	definition.version = 2;
	definition.title = "Confirmed second setting";
	definition.scenes = definition.scenes.filter(
		(scene) => scene.id !== "reading",
	);
	return {
		worldId: definition.id,
		idempotencyKey: "change-2",
		expectedRevision: 0,
		simulationTime: 3,
		kind: "definition",
		sceneId: null,
		actorIds: [],
		audience: [],
		summary: "",
		facts: [],
		moves: [],
		definition,
		relocations: [{ agentId: "sol", sceneId: "meeting" }],
	};
}

test("definition change is an explicit quiet event with an occupied-location mapping", () => {
	const current = initialSnapshot(worldDefinition());
	const proposal = parseProposal(change());
	const next = transition(current, proposal);
	expect(next.definition.version).toBe(2);
	expect(next.revision).toBe(1);
	expect(next.simulationTime).toBe(3);
	expect(next.scenes[0]?.occupants).toEqual(["lina", "mira", "sol"]);
	expect(next.facts).toEqual(current.facts);
	expect(current.definition.version).toBe(1);
});

test("definition change cannot reinterpret old time, erase people/facts or move without mapping", () => {
	const current = initialSnapshot(worldDefinition());
	for (const edit of [
		(p: ReturnType<typeof change>) => {
			p.relocations = [];
		},
		(p: ReturnType<typeof change>) => {
			p.definition.timeUnit = "different";
		},
		(p: ReturnType<typeof change>) => {
			p.definition.initialTime = 1;
		},
		(p: ReturnType<typeof change>) => {
			p.definition.lore = [];
		},
		(p: ReturnType<typeof change>) => {
			p.definition.agents.pop();
		},
		(p: ReturnType<typeof change>) => {
			required(p.definition.scenes[0]).occupants = ["sol"];
		},
		(p: ReturnType<typeof change>) => {
			p.summary = "Invented event narration";
		},
	]) {
		const input = change();
		edit(input);
		expect(() => transition(current, parseProposal(input))).toThrow();
	}
});

test("definition variant rejects unknown payloads and nonconsecutive versions", () => {
	expect(() => parseProposal({ ...change(), script: "execute" })).toThrow();
	const input = change();
	input.definition.version = 4;
	expect(() =>
		transition(initialSnapshot(worldDefinition()), parseProposal(input)),
	).toThrow();
});

test("paired LIFE definition migration preserves experience and asymmetric growth with explicit new baselines", () => {
	const world = initialSnapshot(worldDefinition()),
		definition = lifeDefinition();
	const commit = socialCommit(),
		progressed = transition(world, commit.world);
	const state = applyLifeTransition(
		initialLifeState(world, definition),
		world,
		progressed,
		definition,
		commit,
		identityPolicy(),
	);
	const input = change();
	input.expectedRevision = 1;
	const nextWorld = transition(progressed, parseProposal(input));
	const nextDefinition = structuredClone(definition);
	nextDefinition.revision = 2;
	nextDefinition.traits.push({
		id: "new-axis",
		label: "New authored trait",
		min: 0,
		max: 5,
		initial: 3,
	});
	const next = migrateLifeDefinition(
		state,
		progressed,
		nextWorld,
		definition,
		nextDefinition,
	);
	expect(next).toMatchObject({
		revision: 2,
		worldRevision: 2,
		definitionRevision: 2,
		baseWorldRevision: 0,
	});
	expect(next.experiences).toEqual(state.experiences);
	expect(next.growthHistory).toEqual(state.growthHistory);
	expect(next.attitudes).toEqual(state.attitudes);
	expect(
		next.traits
			.filter((trait) => trait.axisId === "new-axis")
			.map((trait) => trait.value),
	).toEqual([3, 3, 3]);
	for (const edit of [
		(d: typeof definition) => {
			required(d.traits[0]).initial = 1;
		},
		(d: typeof definition) => {
			d.participants.pop();
		},
		(d: typeof definition) => {
			d.attitudes = [];
		},
	]) {
		const bad = structuredClone(nextDefinition);
		edit(bad);
		expect(() =>
			migrateLifeDefinition(state, progressed, nextWorld, definition, bad),
		).toThrow();
	}
});
