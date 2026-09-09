import { expect, test } from "bun:test";
import { assertKnowledgeGrantTransition } from "../src/world/life-knowledge.ts";
import { initialLifeState } from "../src/world/life-transition.ts";
import type { LifeCommitV3 } from "../src/world/life-types.ts";
import { parseLifeCommit } from "../src/world/life-validation.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { lifeCommit, lifeDefinition } from "./life-fixture.ts";
import { worldDefinition } from "./world-fixture.ts";

function stepCommit(): LifeCommitV3 {
	return {
		...lifeCommit(),
		version: 3,
		stepId: "step-1",
		socialResolutionId: null,
		knowledgeGrants: [],
	};
}

test("versioned autonomous commits retain knowledge and reject unknown fields", () => {
	const commit = stepCommit();
	expect(parseLifeCommit(commit)).toEqual(commit);
	expect(() =>
		parseLifeCommit({ ...commit, execute: "unsupported" }),
	).toThrow();
	expect(() => parseLifeCommit({ ...commit, stepId: null })).toThrow();
});

test("autonomous commit version cannot bypass prior knowledge and disclosure authority", () => {
	const world = initialSnapshot(worldDefinition()),
		definition = lifeDefinition();
	const previous = initialLifeState(world, definition),
		commit = stepCommit();
	commit.knowledgeGrants = [
		{
			id: "grant",
			claim: { kind: "world_fact", id: "secret" },
			fromAgentId: "lina",
			toAgentId: "mira",
			sourceEventId: "test-world:1",
			experienceId: "learn",
			lifeRevision: 1,
			definitionRevision: 1,
			projectionRevision: 1,
			policyDigest: "a".repeat(64),
		},
	];
	expect(() =>
		assertKnowledgeGrantTransition(commit, previous, world, definition),
	).toThrow();
});
