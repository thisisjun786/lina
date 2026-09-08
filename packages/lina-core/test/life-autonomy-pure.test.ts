import { expect, test } from "bun:test";
import {
	buildAutonomyOutcome,
	initialAutonomyState,
	migrateAutonomyState,
	rebindSocialCheckpoint,
} from "../src/world/autonomy-transition.ts";
import {
	assertAutonomyPack,
	parseAutonomyDefinition,
	parseAutonomyState,
} from "../src/world/autonomy-validation.ts";
import { selectLifeEvent } from "../src/world/events.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { literal, rule } from "./life-authoring-fixture.ts";
import {
	autonomyPack,
	autonomySource,
	pureStep,
} from "./life-autonomy-pure-fixture.ts";
import { required } from "./life-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";

test("strict definitions reject unknown fields, references, conflicting mapped effects and overcapacity", () => {
	const pack = autonomyPack();
	expect(() =>
		parseAutonomyDefinition({ ...pack.autonomy, extra: true }),
	).toThrow();
	required(pack.autonomy.events[0]?.needWeights[0]).needId = "absent";
	expect(() => assertAutonomyPack(pack)).toThrow();
	const mapped = autonomyPack();
	mapped.rules = [
		rule("bad", {
			effects: [
				{
					kind: "attitude",
					from: { kind: "actor" },
					to: { kind: "target" },
					axisId: "relation",
					delta: literal(1),
				},
			],
		}),
	];
	expect(() => assertAutonomyPack(mapped)).toThrow(/mapped/i);
	const large = autonomyPack();
	large.autonomy.needs = Array.from({ length: 1500 }, (_, i) => ({
		...required(large.autonomy.needs[0]),
		id: `n${i}`,
	}));
	expect(() => assertAutonomyPack(large)).toThrow(/capacity/i);
});
test("seeded candidates record separate need goal trait habit novelty contributions", () => {
	const source = autonomySource();
	required(source.life.traits.find((x) => x.agentId === "lina")).value = 1;
	required(source.life.habits.find((x) => x.agentId === "lina")).value = true;
	const d = selectLifeEvent(source, "step-1");
	const lina = required(d.candidates.find((x) => x.agentId === "lina"));
	expect(lina.weight).toBe(24);
	expect(
		lina.contributions.filter((x) => x.kind === "need").map((x) => x.value),
	).toEqual([2]);
	expect(
		lina.contributions.filter((x) => x.kind === "goal").map((x) => x.value),
	).toEqual([12]);
	expect(d.maxModelCalls).toBe(6);
	expect(d.random.value).toBe(0.6322355541629958);
	expect(source.autonomy.selectionIndex).toBe(0);
	required(source.autonomy.goals[0]).progress = 0.5;
	expect(
		required(
			selectLifeEvent(source, "step-1").candidates.find(
				(x) => x.agentId === "lina",
			),
		).weight,
	).toBe(18);
	source.autonomy.families = [
		{ familyId: "meet", agentId: "lina", lastStepNumber: 0, count: 2 },
	];
	expect(
		selectLifeEvent(source, "step-1").candidates.some(
			(x) => x.agentId === "lina",
		),
	).toBe(false);
	source.autonomy.stepNumber = 3;
	expect(
		required(
			selectLifeEvent(source, "step-1").candidates.find(
				(x) => x.agentId === "lina",
			),
		).weight,
	).toBe(17);
});
test("cast preflight rejects five calls and quiet requires no model calls", () => {
	const source = autonomySource();
	required(source.config.limits ?? undefined).maxModelCalls = 5;
	expect(() => selectLifeEvent(source, "step-1")).toThrow(/6/);
	required(source.pack.eventFamilies[0]).condition = literal(false);
	expect(selectLifeEvent(source, "step-1")).toMatchObject({
		kind: "quiet",
		maxModelCalls: 0,
	});
});
test("initial 1 to quiet 7 preserves inputs and no experiences or publication", () => {
	const source = autonomySource();
	source.pack.rules = [
		rule("set", {
			effects: [{ kind: "assign", variableId: "count", value: literal(7) }],
		}),
	];
	required(source.pack.eventFamilies[0]).condition = literal(false);
	expect(initialAutonomyState(source, 42).variables["count"]).toBe(1);
	const step = pureStep(source);
	step.decision = selectLifeEvent(source, step.id);
	const out = buildAutonomyOutcome(step, null);
	expect(out.kind).toBe("quiet");
	expect(out.nextState.variables["count"]).toBe(7);
	expect(out.nextState.needs.map((x) => x.value)).toEqual([3, 3, 3]);
	expect(out.nextState.selectionIndex).toBe(0);
	expect(out.commit.world.kind).toBe("tick");
	expect(out.commit.experiences).toEqual([]);
	expect(out.commit.effects).toEqual([]);
	expect(out.commit.consumedInputIds).toEqual([]);
	expect(out.commit.checkpoint).toEqual(source.life.checkpoint);
	expect(parseAutonomyState(out.nextState)).toEqual(out.nextState);
	expect(source.autonomy.variables["count"]).toBe(1);
});
test("checkpoint rebind preserves social counters and migration keeps accepted 7", () => {
	const source = autonomySource(),
		checkpoint = checkpointFixture();
	const next = rebindSocialCheckpoint(
		checkpoint,
		{ worldRevision: 2, lifeRevision: 2, simulationTime: 2 },
		{ ...source.autonomy.variables, count: 7 },
	);
	expect(next.engineId).toBe("ensemble");
	if (next.engineId !== "ensemble") throw Error("checkpoint");
	expect(next.data.variables["count"]).toBe(7);
	expect(next.data.state).toEqual(checkpoint.data.state);
	expect(next.data.rng).toEqual(checkpoint.data.rng);
	source.autonomy.variables["count"] = 7;
	const pack = structuredClone(source.pack);
	pack.version = 2;
	pack.world.version = 2;
	pack.life.revision = 2;
	pack.autonomy.needs.push({
		id: "new",
		label: "New",
		min: 0,
		max: 9,
		initial: 9,
		driftPerStep: 0,
	});
	const result = migrateAutonomyState(source.autonomy, source.pack, pack, {
		worldRevision: 1,
		lifeRevision: 1,
		simulationTime: 1,
	});
	expect(result.state.variables["count"]).toBe(7);
	expect(result.state.seed).toBe(42);
	expect(
		result.state.needs.filter((x) => x.needId === "new").map((x) => x.value),
	).toEqual([9, 9, 9]);
	required(pack.autonomy.needs[0]).driftPerStep = 3;
	expect(() =>
		migrateAutonomyState(source.autonomy, source.pack, pack, {
			worldRevision: 1,
			lifeRevision: 1,
			simulationTime: 1,
		}),
	).toThrow();
});

test("keyed draw and weights are stable under authored list ordering and private input mutations", () => {
	const source = autonomySource(),
		first = selectLifeEvent(source, "stable");
	source.pack.roles.reverse();
	source.pack.autonomy.goals.reverse();
	const input = required(source.inputs[0]);
	if (input.version !== 1) throw Error("Expected legacy application input");
	input.source.text = "UNTRUSTED_ALTERNATE";
	source.autonomy.variables["secret"] = "unobserved";
	expect(selectLifeEvent(source, "stable")).toEqual(first);
	const distinct = selectLifeEvent(source, "different");
	expect(distinct.random.value).not.toBe(first.random.value);
});
test("safe quiet assignment followed by initialization reads accepted checkpoint copy and rejects disagreement", () => {
	const source = autonomySource();
	const checkpoint = checkpointFixture();
	source.life.checkpoint = checkpoint;
	source.life.version = 2;
	source.life = { ...source.life, version: 2, knowledgeGrants: [] };
	source.life.worldRevision = 1;
	source.life.revision = 1;
	source.world.revision = 1;
	source.world.simulationTime = 1;
	checkpoint.data.variables["count"] = 7;
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	expect(initialAutonomyState(source, 42).variables["count"]).toBe(7);
	source.autonomy.worldRevision = 1;
	source.autonomy.lifeRevision = 1;
	expect(() => selectLifeEvent(source, "mismatch")).toThrow(/checkpoint/i);
});

test("state decoder rejects unknown shape, duplicate owners, unsafe seed and future counters", () => {
	const state = autonomySource().autonomy;
	expect(() => parseAutonomyState({ ...state, extra: 1 })).toThrow();
	expect(() => parseAutonomyState({ ...state, seed: 0x100000000 })).toThrow();
	expect(() => parseAutonomyState({ ...state, selectionIndex: 1 })).toThrow();
	expect(() =>
		parseAutonomyState({ ...state, needs: [...state.needs, state.needs[0]] }),
	).toThrow();
});

test("eligible queued causes use normal weighting and overdepth remains stopped on quiet", () => {
	const source = autonomySource();
	source.autonomy.pendingEvents = [
		{
			id: "queued",
			familyId: "meet",
			actorIds: ["sol"],
			summary: "private queue text",
			parentStepId: "parent",
			rootStepId: "root",
			depth: 1,
			status: "pending",
		},
	];
	const d = selectLifeEvent(source, "queued-step");
	expect(d.agentId).toBe("sol");
	expect(d.parent?.id).toBe("queued");
	source.autonomy.pendingEvents[0] = {
		...required(source.autonomy.pendingEvents[0]),
		depth: 3,
	};
	required(source.pack.eventFamilies[0]).condition = literal(false);
	const step = pureStep(source);
	step.decision = selectLifeEvent(source, step.id);
	const out = buildAutonomyOutcome(step, null);
	expect(out.nextState.pendingEvents[0]?.status).toBe("stopped");
	expect(out.commit.experiences).toEqual([]);
});

test("migration cannot take over a previously accepted personal goal identity", () => {
	const source = autonomySource();
	source.autonomy.worldRevision = 1;
	source.autonomy.lifeRevision = 1;
	source.autonomy.stepNumber = 1;
	source.autonomy.goals.push({
		id: "personal",
		agentId: "lina",
		description: "Own goal",
		priority: 2,
		familyIds: ["meet"],
		progress: 0,
		status: "active",
		createdAtStepId: "old-step",
		lastStepId: "old-step",
		experienceIds: ["observed"],
	});
	const pack = structuredClone(source.pack);
	pack.version = 2;
	pack.world.version = 2;
	pack.life.revision = 2;
	pack.autonomy.goals.push({
		id: "personal",
		agentId: "mira",
		description: "Different goal",
		priority: 2,
		familyIds: ["meet"],
	});
	expect(() =>
		migrateAutonomyState(source.autonomy, source.pack, pack, {
			worldRevision: 2,
			lifeRevision: 2,
			simulationTime: 2,
		}),
	).toThrow(/goal/i);
});
