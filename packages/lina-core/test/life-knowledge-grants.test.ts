import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import {
	applyLifeTransition,
	initialLifeState,
} from "../src/world/life-transition.ts";
import type { ClaimRef, LifeCommitV2 } from "../src/world/life-types.ts";
import { parseLifeState } from "../src/world/life-validation.ts";
import { initialSnapshot, transition } from "../src/world/transition.ts";
import {
	projectLifePerception,
	projectPublication,
} from "../src/world/views.ts";
import {
	identityPolicy,
	lifeCommit,
	lifeDefinition,
	required,
	socialCommit,
} from "./life-fixture.ts";
import { worldActivity, worldDefinition } from "./world-fixture.ts";

function scenario(kind: ClaimRef["kind"] = "life_claim") {
	const ref: ClaimRef = {
		kind,
		id: kind === "life_claim" ? "false-claim" : "secret",
	};
	const def = lifeDefinition();
	const policy = {
		knowers: ["lina"],
		disclosures: [{ agentId: "lina", recipientId: "mira" }],
		publication: [],
	};
	def.projection.disclosures = [{ subject: ref, policy }];
	const initialWorld = initialSnapshot(worldDefinition());
	const initial = initialLifeState(initialWorld, def);
	const first = socialCommit();
	required(first.claims[0]).disclosure.knowers = ["lina"];
	const world = transition(initialWorld, first.world);
	const life = applyLifeTransition(
		initial,
		initialWorld,
		world,
		def,
		first,
		identityPolicy(),
	);
	const commit: LifeCommitV2 = {
		...lifeCommit(),
		version: 2,
		socialResolutionId: "resolution-reveal",
		expectedLifeRevision: 1,
		world: worldActivity({
			expectedRevision: 1,
			simulationTime: 2,
			idempotencyKey: "reveal",
			facts: [],
		}),
		knowledgeGrants: [
			{
				id: "grant",
				claim: ref,
				fromAgentId: "lina",
				toAgentId: "mira",
				sourceEventId: "test-world:2",
				experienceId: "learned",
				lifeRevision: 2,
				definitionRevision: 1,
				projectionRevision: 1,
				policyDigest: lifeDigest(policy),
			},
		],
		experiences: [
			{
				id: "learned",
				agentId: "mira",
				eventId: "test-world:2",
				channel: "told",
				claims: [ref],
				simulationTime: 2,
			},
		],
	};
	const nextWorld = transition(world, commit.world);
	const apply = () =>
		applyLifeTransition(life, world, nextWorld, def, commit, identityPolicy());
	return { ref, def, world, life, commit, nextWorld, apply };
}

for (const kind of ["life_claim", "world_fact"] as const) {
	test(`${kind}: a grant reveals the original statement without changing its truth or permission`, () => {
		const f = scenario(kind);
		const before = JSON.stringify(
			kind === "life_claim" ? f.life.claims : f.world.facts,
		);
		const next = parseLifeState(JSON.parse(JSON.stringify(f.apply())));
		const perceive = (agentId: string) =>
			projectLifePerception(
				f.nextWorld,
				next,
				f.def,
				{ purpose: "life", worldId: "test-world", agentId },
				{ maxChars: 10000, maxRecords: 100 },
			);
		expect(
			perceive("mira")[kind === "life_claim" ? "claims" : "facts"].some(
				(x) => x.id === f.ref.id,
			),
		).toBe(true);
		expect(
			perceive("sol")[kind === "life_claim" ? "claims" : "facts"].some(
				(x) => x.id === f.ref.id,
			),
		).toBe(false);
		expect(next.beliefs).toEqual(f.life.beliefs);
		expect(
			JSON.stringify(kind === "life_claim" ? next.claims : f.nextWorld.facts),
		).toBe(before);
		expect(
			projectPublication(
				f.nextWorld,
				next,
				[],
				f.def.projection,
				{
					purpose: "publication",
					worldId: "test-world",
					agentId: "mira",
					recipientId: "feed",
				},
				{ maxChars: 10000, maxRecords: 100 },
			).claims,
		).toEqual([]);
	});
}

test("the current explicit policy is required even if claim creation metadata allows disclosure", () => {
	const f = scenario();
	required(f.life.claims[0]).disclosure.disclosures = [
		{ agentId: "lina", recipientId: "mira" },
	];
	f.def.projection.disclosures = [];
	expect(f.apply).toThrow(/disclosure|policy/i);
});

test("a newly learned claim cannot be forwarded within the same accepted event", () => {
	const f = scenario();
	const policy = required(f.def.projection.disclosures[0]).policy;
	policy.knowers.push("mira");
	policy.disclosures.push({ agentId: "mira", recipientId: "sol" });
	required(f.commit.knowledgeGrants[0]).policyDigest = lifeDigest(policy);
	f.commit.knowledgeGrants.push({
		...required(f.commit.knowledgeGrants[0]),
		id: "forward",
		fromAgentId: "mira",
		toAgentId: "sol",
		experienceId: "forwarded",
	});
	f.commit.experiences.push({
		...required(f.commit.experiences[0]),
		id: "forwarded",
		agentId: "sol",
	});
	f.commit.world.audience.push("sol");
	const nextWorld = transition(f.world, f.commit.world);
	expect(() =>
		applyLifeTransition(
			f.life,
			f.world,
			nextWorld,
			f.def,
			f.commit,
			identityPolicy(),
		),
	).toThrow(/knowledge|sender/i);
});

test("a grant cannot rewrite historical knowledge or point at a different recipient experience", () => {
	for (const mutation of ["backdate", "recipient", "duplicate"] as const) {
		const f = scenario();
		if (mutation === "backdate")
			required(f.commit.knowledgeGrants[0]).sourceEventId = "test-world:1";
		if (mutation === "recipient")
			required(f.commit.knowledgeGrants[0]).experienceId = "told";
		if (mutation === "duplicate")
			f.commit.knowledgeGrants.push({
				...required(f.commit.knowledgeGrants[0]),
				id: "grant-copy",
			});
		expect(f.apply).toThrow();
	}
});
