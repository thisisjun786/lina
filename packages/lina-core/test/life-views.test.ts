import { expect, test } from "bun:test";
import {
	applyLifeTransition,
	initialLifeState,
} from "../src/world/life-transition.ts";
import type {
	ProjectionPolicy,
	WorldBinding,
} from "../src/world/life-types.ts";
import { initialSnapshot, transition } from "../src/world/transition.ts";
import type { WorldEvent } from "../src/world/types.ts";
import {
	identityPolicy,
	lifeDefinition,
	required,
	socialCommit,
} from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

const views = () => import("../src/world/views.ts");
const limits = { maxChars: 10000, maxRecords: 100 };
function accepted() {
	const def = lifeDefinition();
	const old = initialSnapshot(worldDefinition());
	const commit = socialCommit();
	const world = transition(old, commit.world);
	const life = applyLifeTransition(
		initialLifeState(old, def),
		old,
		world,
		def,
		commit,
		identityPolicy(),
	);
	const event: WorldEvent = {
		...commit.world,
		id: "test-world:1",
		revision: 1,
		acceptedAt: "2026-09-07T00:00:00Z",
		origin: "fictional",
		definitionVersion: 1,
	};
	const binding: WorldBinding = {
		version: 1,
		agentId: "lina",
		worldId: "test-world",
		revision: 1,
		projectionPolicyRevision: 1,
	};
	return { def, world, life, event, binding };
}
test("perception keeps false belief separate from oracle truth and other minds", async () => {
	const { projectLifePerception } = await views();
	const { def, world, life } = accepted();
	const result = projectLifePerception(
		world,
		life,
		def,
		{ purpose: "life", worldId: "test-world", agentId: "lina" },
		limits,
	);
	expect(result.beliefs).toEqual([
		{
			id: "belief-a",
			claim: { kind: "life_claim", id: "false-claim" },
			text: "The key is red",
			stance: "believes",
			confidence: "certain",
		},
	]);
	const serialized = JSON.stringify(result);
	for (const hidden of [
		"truth",
		"knowers",
		"witness",
		"whisper",
		"sourceEventId",
		"supersedes",
	])
		expect(serialized).not.toContain(hidden);
	expect(result.experiences[0]?.channel).toBe("told");
	const outsider = projectLifePerception(
		world,
		life,
		def,
		{ purpose: "life", worldId: "test-world", agentId: "sol" },
		limits,
	);
	expect(outsider.beliefs).toEqual([]);
	expect(outsider.claims).toEqual([]);
});
test("shared persona uses only authored labels and current identity; retained history remains", async () => {
	const { projectSharedPersona } = await views();
	const { def, life, binding } = accepted();
	const identity = identityPolicy();
	const shared = projectSharedPersona(life, def, binding, identity, limits);
	expect(shared?.traits).toEqual([{ label: "Authored axis", value: 1 }]);
	expect(shared?.attitudes).toEqual([
		{ toAgentId: "mira", label: "Authored attitude", value: -1 },
	]);
	const serialized = JSON.stringify(shared);
	for (const hidden of [
		"told",
		"The key is red",
		"false-claim",
		"evidence",
		"axisId",
		"experience",
	])
		expect(serialized).not.toContain(hidden);
	required(identity.profiles[0]).lockedTraitIds = ["axis"];
	expect(
		projectSharedPersona(life, def, binding, identity, limits)?.traits,
	).toEqual([]);
	required(identity.profiles[0]).profileRevision = 2;
	expect(
		projectSharedPersona(life, def, binding, identity, limits)?.attitudes,
	).toEqual([]);
	required(identity.profiles[0]).evolution = "manual";
	expect(
		projectSharedPersona(life, def, binding, identity, limits)?.traits,
	).toEqual([]);
	expect(life.growthHistory).toHaveLength(2);
	expect(
		projectSharedPersona(
			life,
			def,
			{ ...binding, worldId: null, projectionPolicyRevision: 0 },
			identity,
			limits,
		),
	).toBeNull();
	expect(() =>
		projectSharedPersona(
			life,
			def,
			{ ...binding, worldId: "other" },
			identity,
			limits,
		),
	).toThrow();
});
test("private records and labels never change public truncation or consume budgets", async () => {
	const { projectLifePerception, projectSharedPersona } = await views();
	const { def, world, life, binding } = accepted();
	const scope = {
		purpose: "life",
		worldId: "test-world",
		agentId: "sol",
	} as const;
	const budget = { maxChars: 1000, maxRecords: 1 };
	const before = projectLifePerception(world, life, def, scope, budget);
	const shared = projectSharedPersona(
		life,
		def,
		binding,
		identityPolicy(),
		budget,
	);
	life.claims.push({
		id: "private",
		text: "PRIVATE".repeat(3000),
		sourceEventId: "test-world:1",
		truth: "true",
		supersedes: null,
		disclosure: { knowers: ["mira"], disclosures: [], publication: [] },
	});
	world.facts.unshift({
		id: "private-fact",
		text: "PRIVATE",
		knownTo: ["mira"],
		sourceEventId: "test-world:1",
	});
	expect(projectLifePerception(world, life, def, scope, budget)).toEqual(
		before,
	);
	expect(
		projectSharedPersona(life, def, binding, identityPolicy(), budget),
	).toEqual(shared);
});
test("publication requires separate exact recipient grant and rechecks current revocation", async () => {
	const { projectPublication } = await views();
	const { world, life, def, event } = accepted();
	const scope = {
		purpose: "publication",
		worldId: "test-world",
		agentId: "lina",
		recipientId: "feed",
	} as const;
	const policy: ProjectionPolicy = {
		...def.projection,
		revision: 2,
		disclosures: [
			{
				subject: { kind: "world_event", id: event.id },
				policy: {
					knowers: ["lina"],
					disclosures: [{ agentId: "lina", recipientId: "feed" }],
					publication: ["feed"],
				},
			},
		],
	};
	const published = projectPublication(
		world,
		life,
		[event],
		policy,
		scope,
		limits,
	);
	expect(published.events).toEqual([
		{
			id: "test-world:1",
			summary: "A bell rang during the meeting",
			simulationTime: 1,
		},
	]);
	expect(published.facts).toEqual([]);
	expect(published.claims).toEqual([]);
	expect(published.scene).toBeNull();
	expect(published.projectionPolicyRevision).toBe(2);
	expect(
		projectPublication(
			world,
			life,
			[event],
			policy,
			{ ...scope, recipientId: "other" },
			limits,
		).events,
	).toEqual([]);
	required(policy.disclosures[0]).policy.publication = [];
	expect(
		projectPublication(world, life, [event], policy, scope, limits).events,
	).toEqual([]);
});
test("scene narration requires a visible current scene and independent policy", async () => {
	const { projectLifePerception } = await views();
	const { world, life, def } = accepted();
	const scope = {
		purpose: "life",
		worldId: "test-world",
		agentId: "lina",
	} as const;
	expect(
		projectLifePerception(world, life, def, scope, limits).scene,
	).toBeNull();
	def.projection.disclosures.push({
		subject: { kind: "world_scene", id: "meeting" },
		policy: { knowers: ["lina"], disclosures: [], publication: [] },
	});
	expect(projectLifePerception(world, life, def, scope, limits).scene?.id).toBe(
		"meeting",
	);
	expect(
		projectLifePerception(
			world,
			life,
			def,
			{ ...scope, agentId: "sol" },
			limits,
		).scene,
	).toBeNull();
});
test("author inspection is detached and rejects a model-style admin flag", async () => {
	const { projectAuthorInspection } = await views();
	const { world, life, def, event } = accepted();
	const result = projectAuthorInspection(world, life, def, [event], {
		purpose: "author",
		worldId: "test-world",
	});
	expect(result.life.claims[0]?.truth).toBe("false");
	result.life.claims.pop();
	expect(life.claims).toHaveLength(1);
	const untrustedScope = {
		purpose: "author",
		worldId: "test-world",
		isAdmin: true,
	} as const;
	expect(() =>
		projectAuthorInspection(world, life, def, [event], untrustedScope),
	).toThrow();
});

test("recipient grants, disclosures and knowledge remain independently required", async () => {
	const { projectPublication } = await views();
	const { world, life, def, event } = accepted();
	const scope = {
		purpose: "publication",
		worldId: "test-world",
		agentId: "lina",
		recipientId: "feed",
	} as const;
	for (const permission of [
		{ knowers: ["lina"], disclosures: [], publication: ["feed"] },
		{
			knowers: ["lina"],
			disclosures: [{ agentId: "lina", recipientId: "feed" }],
			publication: [],
		},
		{
			knowers: [],
			disclosures: [{ agentId: "lina", recipientId: "feed" }],
			publication: ["feed"],
		},
	]) {
		const policy = {
			...def.projection,
			disclosures: [
				{
					subject: { kind: "world_event", id: event.id } as const,
					policy: permission,
				},
			],
		};
		expect(
			projectPublication(world, life, [event], policy, scope, limits).events,
		).toEqual([]);
	}
});
test("whole-record budgets never count hidden records in publication or leak private labels", async () => {
	const { projectPublication, projectSharedPersona } = await views();
	const { world, life, def, event, binding } = accepted();
	const scope = {
		purpose: "publication",
		worldId: "test-world",
		agentId: "lina",
		recipientId: "feed",
	} as const;
	const policy: ProjectionPolicy = {
		...def.projection,
		disclosures: [
			{
				subject: { kind: "world_event", id: event.id },
				policy: {
					knowers: ["lina"],
					disclosures: [{ agentId: "lina", recipientId: "feed" }],
					publication: ["feed"],
				},
			},
		],
	};
	const expected = projectPublication(world, life, [event], policy, scope, {
		maxChars: 500,
		maxRecords: 1,
	});
	const hidden = {
		...event,
		id: "test-world:0",
		summary: "PRIVATE EVENT",
		audience: ["mira"],
	};
	expect(
		projectPublication(world, life, [hidden, event], policy, scope, {
			maxChars: 500,
			maxRecords: 1,
		}),
	).toEqual(expected);
	expect(expected.truncated).toBe(false);
	const noBudget = projectPublication(world, life, [event], policy, scope, {
		maxChars: 500,
		maxRecords: 0,
	});
	expect(noBudget.events).toEqual([]);
	expect(noBudget.truncated).toBe(true);
	const sharedBefore = projectSharedPersona(
		life,
		def,
		binding,
		identityPolicy(),
		limits,
	);
	def.traits.push({
		id: "hidden-axis",
		label: "PRIVATE LABEL",
		min: 0,
		max: 10,
		initial: 0,
	});
	life.traits.push({
		agentId: "mira",
		axisId: "hidden-axis",
		value: 3,
		profileRevision: 1,
	});
	expect(
		projectSharedPersona(life, def, binding, identityPolicy(), limits),
	).toEqual(sharedBefore);
	expect(() =>
		projectPublication(world, life, [event], policy, scope, {
			maxChars: 1,
			maxRecords: 1,
		}),
	).toThrow("budget");
});
test("hidden correction cannot change a visible claim and superseded belief remains in author history", async () => {
	const { projectLifePerception } = await views();
	const { def, world, life } = accepted();
	const scope = {
		purpose: "life",
		worldId: "test-world",
		agentId: "lina",
	} as const;
	const before = projectLifePerception(world, life, def, scope, limits);
	life.claims.push({
		id: "hidden-correction",
		text: "PRIVATE CORRECTION",
		sourceEventId: "test-world:1",
		truth: "true",
		supersedes: "false-claim",
		disclosure: { knowers: ["mira"], disclosures: [], publication: [] },
	});
	expect(projectLifePerception(world, life, def, scope, limits)).toEqual(
		before,
	);
	life.beliefs.push({
		...required(life.beliefs[0]),
		id: "new-belief",
		supersedes: "belief-a",
		stance: "disbelieves",
	});
	expect(
		projectLifePerception(world, life, def, scope, limits).beliefs.map((x) => [
			x.id,
			x.stance,
		]),
	).toEqual([["new-belief", "disbelieves"]]);
	expect(life.beliefs).toHaveLength(2);
});
