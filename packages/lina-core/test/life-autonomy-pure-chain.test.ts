import { expect, test } from "bun:test";
import {
	buildAutonomyOutcome,
	prepareAutonomyObservation,
} from "../src/world/autonomy-transition.ts";
import { selectLifeEvent } from "../src/world/events.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { applyLifeTransition } from "../src/world/life-transition.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import { transition } from "../src/world/transition.ts";
import { literal, read, rule } from "./life-authoring-fixture.ts";
import {
	autonomySource,
	completedModel,
	emptyReflection,
	pureStep,
} from "./life-autonomy-pure-fixture.ts";
import { socialStep } from "./life-autonomy-pure-social-fixture.ts";
import { required } from "./life-fixture.ts";

test("hand oracle: authored 1 becomes quiet 7 before first social bootstrap, never unrelated 9", () => {
	const source = autonomySource();
	required(source.pack.eventFamilies[0]).condition = {
		op: "eq",
		left: read("count"),
		right: literal(7),
	};
	source.pack.rules = [
		rule("quiet-assignment", {
			effects: [{ kind: "assign", variableId: "count", value: literal(7) }],
		}),
	];
	expect(source.autonomy.variables["count"]).toBe(1);
	const quiet = pureStep(source);
	quiet.decision = selectLifeEvent(source, quiet.id);
	expect(quiet.decision.kind).toBe("quiet");
	const tick = buildAutonomyOutcome(quiet, null),
		world = transition(source.world, tick.commit.world),
		life = applyLifeTransition(
			source.life,
			source.world,
			world,
			source.pack.life,
			tick.commit,
			source.identity,
		);
	expect(life.checkpoint.engineId).toBe("empty");
	expect(tick.nextState.variables["count"]).toBe(7);
	expect(tick.nextState.selectionIndex).toBe(0);
	const { step, social } = socialStep({ acceptedCount: 9 });
	step.id = "step-2";
	step.idempotencyKey = "second-key";
	step.source = { ...source, world, life, autonomy: tick.nextState };
	step.decision = selectLifeEvent(step.source, step.id);
	expect(step.decision.agentId).toBe("lina");
	expect(step.decision.random.value).toBe(0.5481816803116806);
	step.models = [
		completedModel(step, "director", "lina", "Current opportunity"),
		completedModel(step, "actor", "lina", JSON.stringify(step.intent)),
		completedModel(step, "target", "mira", JSON.stringify(step.targetResponse)),
	];
	if (
		"kind" in social.input ||
		social.input.version !== 2 ||
		social.result?.kind !== "advanced"
	)
		throw Error("fixture");
	social.input.world = world;
	social.input.life = life;
	social.input.checkpoint = life.checkpoint;
	social.input.rulePack = compileSocialPack(source.pack);
	social.input.simulationTime = 2;
	social.input.autonomy = {
		stepId: step.id,
		worldRevision: 1,
		lifeRevision: 1,
		stateDigest: lifeDigest(tick.nextState),
		variables: structuredClone(tick.nextState.variables),
	};
	const cp = social.result.checkpoint;
	cp.data.worldRevision = 2;
	cp.data.lifeRevision = 2;
	cp.data.simulationTime = 2;
	cp.data.variables = structuredClone(tick.nextState.variables);
	for (const intro of [
		...cp.data.agentIntroductions,
		...cp.data.predicateIntroductions,
		...cp.data.variableIntroductions,
	])
		intro.worldRevision = 1;
	cp.dataDigest = lifeDigest(cp.data);
	social.inputDigest = lifeDigest(social.input);
	social.result.inputDigest = social.inputDigest;
	social.result.previousCheckpointDigest = lifeDigest(life.checkpoint);
	const { resultDigest: _, ...body } = social.result;
	social.result.resultDigest = lifeDigest(body);
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	for (const id of observed.agentIds)
		step.models.push(
			completedModel(step, "reflection", id, JSON.stringify(emptyReflection())),
		);
	const out = buildAutonomyOutcome(step, social);
	expect(out.nextState.variables["count"]).toBe(7);
	expect(out.nextState.worldRevision).toBe(2);
	if (out.commit.checkpoint.engineId !== "ensemble") throw Error("checkpoint");
	expect(out.commit.checkpoint.data.variables["count"]).toBe(7);
	expect(out.commit.checkpoint.data.state.step).toBe(1);
	expect(out.commit.checkpoint.data.rng).toEqual({
		algorithm: "lcg32-v1",
		seed: 42,
		state: 1083814273,
		drawIndex: 1,
	});
});
