import { expect, test } from "bun:test";
import {
	buildAutonomyOutcome,
	prepareAutonomyObservation,
} from "../src/world/autonomy-transition.ts";
import { migrateLifeDefinitionResult } from "../src/world/life-definition.ts";
import { applyLifeTransition } from "../src/world/life-transition.ts";
import { transition } from "../src/world/transition.ts";
import {
	completedModel,
	emptyReflection,
} from "./life-autonomy-pure-fixture.ts";
import { socialStep } from "./life-autonomy-pure-social-fixture.ts";

test("definition migration rejects weights that overflow an accepted reflected goal", () => {
	const { step, social } = socialStep();
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	for (const agentId of observed.agentIds) {
		const reflection = emptyReflection();
		if (agentId === "lina")
			reflection.goals.push({
				id: "large-valid-goal",
				description: "A private ambition",
				priority: 2e15,
				familyIds: ["meet"],
				progress: 0,
				status: "active",
				experienceIds: observed.life.experiences
					.filter((x) => x.agentId === agentId)
					.map((x) => x.id),
			});
		step.models.push(
			completedModel(step, "reflection", agentId, JSON.stringify(reflection)),
		);
	}
	const outcome = buildAutonomyOutcome(step, social);
	const oldWorld = transition(step.source.world, outcome.commit.world);
	const life = applyLifeTransition(
		step.source.life,
		step.source.world,
		oldWorld,
		step.source.pack.life,
		outcome.commit,
		step.source.identity,
	);
	const pack = structuredClone(step.source.pack);
	pack.version++;
	pack.world.version++;
	pack.life.revision++;
	const policy = pack.autonomy.events[0];
	if (!policy) throw Error("Missing fixture policy");
	const nextWorld = {
		...oldWorld,
		definition: pack.world,
		revision: oldWorld.revision + 1,
	};
	const migrate = () =>
		migrateLifeDefinitionResult(
			life,
			oldWorld,
			nextWorld,
			step.source.pack.life,
			pack.life,
			{ old: step.source.pack, next: pack },
			outcome.nextState,
		);
	// The current multiplier is admissible: only the authored change should fail.
	expect(
		migrate().autonomyState?.goals.find((g) => g.id === "large-valid-goal")
			?.priority,
	).toBe(2e15);
	policy.goalWeight = 5;
	expect(migrate).toThrow(/number|weight|capacity/i);
});

test("a reflected goal cannot poison future event weights behind a cooldown", () => {
	const { step, social } = socialStep();
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	for (const agentId of observed.agentIds) {
		const reflection = emptyReflection();
		if (agentId === "lina")
			reflection.goals.push({
				id: "unsafe-future-goal",
				description: "A private ambition",
				priority: 3e15,
				familyIds: ["meet"],
				progress: 0,
				status: "active",
				experienceIds: observed.life.experiences
					.filter((x) => x.agentId === agentId)
					.map((x) => x.id),
			});
		step.models.push(
			completedModel(step, "reflection", agentId, JSON.stringify(reflection)),
		);
	}
	expect(() => buildAutonomyOutcome(step, social)).toThrow(
		/number|weight|capacity/i,
	);
});
