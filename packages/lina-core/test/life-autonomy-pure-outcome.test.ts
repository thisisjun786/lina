import { expect, test } from "bun:test";
import {
	buildAutonomyOutcome,
	prepareAutonomyObservation,
} from "../src/world/autonomy-transition.ts";
import { buildLifeModelInput } from "../src/world/autonomy-views.ts";
import { lifeDigest } from "../src/world/life-json.ts";
import { validateSocialResult } from "../src/world/social-result.ts";
import { literal, rule } from "./life-authoring-fixture.ts";
import {
	completedModel,
	emptyReflection,
	pureStep,
} from "./life-autonomy-pure-fixture.ts";
import { socialStep } from "./life-autonomy-pure-social-fixture.ts";
import { required } from "./life-fixture.ts";
import { socialIntent } from "./life-social-pack-fixture.ts";

test("saved social result retains accepted 7 and all authorized third recipient reflections", () => {
	const { step, social } = socialStep({ reveal: true, acceptedCount: 7 });
	if ("kind" in social.input || !social.result) throw Error("fixture");
	expect(validateSocialResult(social.input, social.result).outcome).toBe(
		"accepted",
	);
	const observed = prepareAutonomyObservation(step, social);
	expect(observed.agentIds).toEqual(["lina", "mira", "sol"]);
	step.reflectionAgentIds = observed.agentIds;
	for (const agentId of observed.agentIds) {
		const request = buildLifeModelInput(step, "reflection", agentId, observed);
		expect(request.input).not.toContain("ACTOR_PRIVATE_CANARY");
		expect(request.input).not.toContain("DIRECTOR_PRIVATE_CANARY");
		if (agentId === "sol")
			expect(request.input).toContain("The hidden key is blue");
		if (agentId === "mira")
			expect(request.input).not.toContain("The hidden key is blue");
		step.models.push(
			completedModel(
				step,
				"reflection",
				agentId,
				JSON.stringify(emptyReflection()),
			),
		);
	}
	const out = buildAutonomyOutcome(step, social);
	expect(out.nextState.variables["count"]).toBe(7);
	expect(out.commit.knowledgeGrants.map((g) => g.toAgentId)).toEqual(["sol"]);
	expect(out.commit.growth).toContainEqual(
		expect.objectContaining({
			kind: "attitude",
			fromAgentId: "lina",
			toAgentId: "mira",
			previous: 0,
			next: 1,
		}),
	);
	expect(out.commit.effects).toHaveLength(1);
	expect(out.commit.consumedInputIds).toEqual([]);
	expect(out.commit.world.summary).not.toContain("ACTOR_PRIVATE_CANARY");
	step.models.pop();
	expect(() => buildAutonomyOutcome(step, social)).toThrow(/reflection/i);
});
test("private inferred consequence gets one reflection without event witness or actor narration", () => {
	const { step, social } = socialStep({ privateConsequence: true });
	const observed = prepareAutonomyObservation(step, social);
	expect(observed.agentIds).toEqual(["lina", "mira", "sol"]);
	step.reflectionAgentIds = observed.agentIds;
	const own = observed.life.experiences.filter((e) => e.agentId === "sol");
	expect(own.map((e) => e.channel)).toEqual(["inferred"]);
	for (const agentId of observed.agentIds)
		step.models.push(
			completedModel(
				step,
				"reflection",
				agentId,
				JSON.stringify(emptyReflection()),
			),
		);
	const out = buildAutonomyOutcome(step, social);
	expect(out.commit.world.audience).toEqual(["lina", "mira"]);
	expect(
		buildLifeModelInput(step, "reflection", "sol", observed).input,
	).not.toContain("ACTOR_PRIVATE_CANARY");
});
test("unknown primitive produces extension tick without invented reflection or publication", () => {
	const step = pureStep();
	const intent = {
		...socialIntent(),
		primitives: [{ kind: "teleport", proposal: "A novel mechanism" }],
	};
	step.models = [
		completedModel(step, "director", "lina", "Opportunity"),
		completedModel(step, "actor", "lina", JSON.stringify(intent)),
	];
	const out = buildAutonomyOutcome(step, null);
	expect(out.kind).toBe("extension_required");
	expect(out.commit.world.kind).toBe("tick");
	expect(out.commit.experiences).toEqual([]);
	expect(out.commit.effects).toEqual([]);
});
test("activity applies authored fact goal and finite stopped causal chain with provenance", () => {
	const { step, social } = socialStep();
	step.source.pack.rules = [
		rule("consequence", {
			effects: [
				{
					kind: "fact",
					id: "authored-fact",
					text: [{ kind: "text", text: "A simulated bell rang" }],
					knownTo: [{ kind: "actor" }],
				},
				{
					kind: "goal",
					id: "rule-goal",
					agent: { kind: "actor" },
					description: [{ kind: "text", text: "Investigate bell" }],
				},
				{
					kind: "event",
					familyId: "meet",
					actorIds: [{ kind: "actor" }],
					summary: [{ kind: "text", text: "Follow up" }],
				},
			],
		}),
	];
	required(step.source.config.limits ?? undefined).maxCausalDepth = 0;
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	for (const id of observed.agentIds)
		step.models.push(
			completedModel(step, "reflection", id, JSON.stringify(emptyReflection())),
		);
	const out = buildAutonomyOutcome(step, social);
	expect(out.commit.world.facts).toEqual([
		{ id: "authored-fact", text: "A simulated bell rang", knownTo: ["lina"] },
	]);
	expect(
		out.nextState.goals.find((g) => g.id === "rule-goal")?.experienceIds,
	).toHaveLength(1);
	expect(out.nextState.pendingEvents).toEqual([
		expect.objectContaining({
			familyId: "meet",
			parentStepId: "step-1",
			rootStepId: "step-1",
			depth: 1,
			status: "stopped",
		}),
	]);
});
test("quiet never evaluates mixed activity rule effects", () => {
	const step = pureStep();
	step.decision.kind = "quiet";
	step.decision.agentId = null;
	step.decision.familyId = null;
	step.source.pack.rules = [
		rule("mixed", {
			effects: [
				{ kind: "assign", variableId: "count", value: literal(7) },
				{
					kind: "event",
					familyId: "meet",
					actorIds: [{ kind: "actor" }],
					summary: [{ kind: "text", text: "not quiet" }],
				},
			],
		}),
	];
	expect(buildAutonomyOutcome(step, null).nextState.variables["count"]).toBe(1);
});
test("forged social input or edited saved actor text cannot authorize effects", () => {
	const { step, social } = socialStep();
	required(step.models[1]?.result ?? undefined).text = JSON.stringify({
		...socialIntent(),
		description: "Changed",
	});
	expect(() => prepareAutonomyObservation(step, social)).toThrow(
		/saved|differs/i,
	);
	const other = socialStep();
	if (other.social.input.version !== 2) throw Error("fixture");
	other.social.input.autonomy.variables["count"] = 9;
	other.social.input.autonomy.stateDigest = lifeDigest(
		other.social.input.autonomy.variables,
	);
	expect(() => prepareAutonomyObservation(other.step, other.social)).toThrow(
		/source/i,
	);
});

test("saved reflection commits unknown belief and owned growth into the next actor input and score", async () => {
	const { applyLifeTransition } = await import(
			"../src/world/life-transition.ts"
		),
		{ transition } = await import("../src/world/transition.ts"),
		{ selectLifeEvent } = await import("../src/world/events.ts");
	const { step, social } = socialStep();
	required(step.source.pack.autonomy.events[0]).cooldownSteps = 0;
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	const evidence = observed.life.experiences
		.filter((x) => x.agentId === "lina")
		.map((x) => x.id);
	const proposal = emptyReflection();
	proposal.claims = [
		{ id: "guess", text: "Perhaps the key is red", supersedes: null },
	];
	proposal.beliefs = [
		{
			id: "belief",
			claim: { kind: "life_claim", id: "guess" },
			stance: "believes",
			confidence: "likely",
			experienceIds: [required(evidence[0])],
			supersedes: null,
		},
	];
	proposal.growth = [
		{
			kind: "trait",
			axisId: "axis",
			next: 1,
			evidenceIds: [required(evidence[0])],
		},
		{ kind: "habit", habitId: "habit", next: true, evidenceIds: evidence },
	];
	proposal.needs = [
		{ needId: "connection", next: 7, experienceIds: [required(evidence[0])] },
	];
	proposal.goals = [
		{
			id: "friend",
			description: "Private goal",
			priority: 3,
			familyIds: ["meet"],
			progress: 0.5,
			status: "active",
			experienceIds: [required(evidence[0])],
		},
	];
	for (const id of observed.agentIds)
		step.models.push(
			completedModel(
				step,
				"reflection",
				id,
				JSON.stringify(id === "lina" ? proposal : emptyReflection()),
			),
		);
	const out = buildAutonomyOutcome(step, social),
		world = transition(step.source.world, out.commit.world),
		life = applyLifeTransition(
			step.source.life,
			step.source.world,
			world,
			step.source.pack.life,
			out.commit,
			step.source.identity,
		);
	expect(life.claims).toContainEqual({
		id: "guess",
		text: "Perhaps the key is red",
		supersedes: null,
		sourceEventId: "test-world:1",
		truth: "unknown",
		disclosure: { knowers: ["lina"], disclosures: [], publication: [] },
	});
	expect(life.beliefs[0]?.agentId).toBe("lina");
	expect(out.nextState.goals[0]?.createdAtStepId).toBeNull();
	const source = { ...step.source, world, life, autonomy: out.nextState };
	expect(
		selectLifeEvent(source, "step-2").candidates.find(
			(x) => x.agentId === "lina",
		)?.weight,
	).toBe(29.5);
	const next = pureStep(source);
	next.models = [
		completedModel(next, "director", "lina", "A later opportunity"),
	];
	const input = JSON.parse(buildLifeModelInput(next, "actor", "lina").input);
	expect(input.traits).toEqual([{ axisId: "axis", value: 1 }]);
	expect(input.habits).toEqual([{ habitId: "habit", value: true }]);
	expect(input.needs).toEqual([{ needId: "connection", value: 7 }]);
});

test("multiple reveals plus private consequences deduplicate reflection recipients", async () => {
	const { compileSocialPack } = await import("../src/world/social-compile.ts");
	const { step, social } = socialStep({
		reveal: true,
		privateConsequence: true,
	});
	if ("kind" in social.input || social.result?.kind !== "advanced")
		throw Error("fixture");
	const claim = { kind: "world_fact" as const, id: "another" },
		policy = {
			knowers: ["lina"],
			disclosures: [
				{ agentId: "lina", recipientId: "mira" },
				{ agentId: "lina", recipientId: "sol" },
			],
			publication: [],
		};
	step.source.world.facts.push({
		id: "another",
		text: "Another private fact",
		knownTo: ["lina"],
		sourceEventId: null,
	});
	step.source.pack.life.projection.disclosures.push({ subject: claim, policy });
	step.source.pack.life.projection.disclosures.sort((a, b) =>
		a.subject.id < b.subject.id ? -1 : 1,
	);
	social.input.rulePack = compileSocialPack(step.source.pack);
	social.input.policies.unshift({
		claim,
		definitionRevision: 1,
		projectionRevision: 1,
		policyDigest: lifeDigest(policy),
	});
	for (const toAgentId of ["mira", "sol"]) {
		social.input.intent.primitives.push({ kind: "reveal", claim, toAgentId });
		social.result.effects.push({
			kind: "reveal",
			claim,
			fromAgentId: "lina",
			toAgentId,
		});
	}
	step.intent = structuredClone(social.input.intent);
	required(step.models[1]?.result ?? undefined).text = JSON.stringify(
		step.intent,
	);
	social.inputDigest = lifeDigest(social.input);
	social.result.inputDigest = social.inputDigest;
	const { resultDigest: _, ...body } = social.result;
	social.result.resultDigest = lifeDigest(body);
	const observation = prepareAutonomyObservation(step, social);
	expect(observation.agentIds).toEqual(["lina", "mira", "sol"]);
	expect(
		observation.life.experiences.filter((e) => e.agentId === "sol"),
	).toHaveLength(3);
	step.reflectionAgentIds = observation.agentIds;
	for (const agentId of observation.agentIds)
		step.models.push(
			completedModel(
				step,
				"reflection",
				agentId,
				JSON.stringify(emptyReflection()),
			),
		);
	expect(
		buildAutonomyOutcome(step, social).commit.knowledgeGrants,
	).toHaveLength(3);
});

test("accepted social marker permits exact pure replay only at its original paired revision", () => {
	const { step, social } = socialStep();
	const observed = prepareAutonomyObservation(step, social);
	step.reflectionAgentIds = observed.agentIds;
	for (const agentId of observed.agentIds)
		step.models.push(
			completedModel(
				step,
				"reflection",
				agentId,
				JSON.stringify(emptyReflection()),
			),
		);
	const original = buildAutonomyOutcome(step, social);
	social.acceptedLifeRevision = 1;
	expect(buildAutonomyOutcome(step, social)).toEqual(original);
	social.acceptedLifeRevision = 2;
	expect(() => buildAutonomyOutcome(step, social)).toThrow(/owned|revision/i);
});
