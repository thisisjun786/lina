import { expect, test } from "bun:test";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { completedModel, pureStep } from "./life-autonomy-pure-fixture.ts";
import { required } from "./life-fixture.ts";
import { socialIntent } from "./life-social-pack-fixture.ts";

test("actor may see own director but target and reflection cannot receive private model prose or raw inbox", () => {
	const step = pureStep();
	step.intent = { ...socialIntent(), description: "ACTOR_SECRET_CANARY" };
	step.models = [
		completedModel(step, "director", "lina", "DIRECTOR_SECRET_CANARY"),
		completedModel(step, "actor", "lina", JSON.stringify(step.intent)),
	];
	const actor = buildLifeModelInput(step, "actor", "lina").input;
	expect(actor).toContain("DIRECTOR_SECRET_CANARY");
	expect(actor).not.toContain("RAW_INBOX_CANARY");
	expect(actor).not.toContain("hidden-value");
	expect(actor).not.toContain("dataDigest");
	expect(actor).not.toContain("candidates");
	for (const [lane, agentId] of [
		["target", "mira"],
		["reflection", "sol"],
	] as const) {
		if (lane === "reflection")
			step.reflectionAgentIds = ["lina", "mira", "sol"];
		const input = buildLifeModelInput(step, lane, agentId, {
			world: step.source.world,
			life: step.source.life,
		}).input;
		expect(input).not.toContain("ACTOR_SECRET_CANARY");
		expect(input).not.toContain("DIRECTOR_SECRET_CANARY");
		expect(input).not.toContain("Private goal");
		expect(input).not.toContain("The hidden key is blue");
	}
});

test("actor serialized observation is unaffected by target private state and excludes all source hashes", () => {
	const step = pureStep();
	step.models = [completedModel(step, "director", "lina", "Own opportunity")];
	const before = buildLifeModelInput(step, "actor", "lina").input;
	step.source.autonomy.variables["secret"] = "PRIVATE_MUTATION";
	required(step.source.life.traits.find((x) => x.agentId === "mira")).value = 2;
	required(step.source.autonomy.needs.find((x) => x.agentId === "mira")).value =
		9;
	required(step.source.profiles.find((x) => x.id === "mira")).personality =
		"TARGET_PRIVATE_CANARY";
	expect(buildLifeModelInput(step, "actor", "lina").input).toBe(before);
	for (const secret of [
		"stateDigest",
		"dataDigest",
		"inputDigest",
		"checkpoint",
		"PRIVATE_MUTATION",
		"TARGET_PRIVATE_CANARY",
	])
		expect(before).not.toContain(secret);
});
