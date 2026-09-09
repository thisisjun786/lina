import { expect, test } from "bun:test";
import { initialLifeState } from "../src/world/life-transition.ts";
import { socialResolutionCommit } from "../src/world/social-commit.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import type {
	SocialResolution,
	SocialResolveInput,
} from "../src/world/social-types.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { identityPolicy } from "./life-fixture.ts";
import { socialIntent, socialPack } from "./life-social-pack-fixture.ts";
import { socialRequest } from "./life-social-store-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";

test("a private rule consequence does not make an unrelated agent an event witness", () => {
	const pack = socialPack(),
		world = initialSnapshot(pack.world);
	const input: SocialResolveInput = {
		version: 1,
		requestId: "private-outcome",
		world,
		life: initialLifeState(world, pack.life),
		identity: identityPolicy(),
		checkpoint: initialLifeState(world, pack.life).checkpoint,
		rulePack: compileSocialPack(pack),
		intent: socialIntent(),
		targetResponse: socialRequest().targetResponse,
		simulationTime: 1,
		bootstrap: null,
		policies: [],
		limits: socialRequest().limits,
	};
	// This test checks projection only; engine validity is independently enforced before this function.
	const result: SocialResolution = {
		version: 1,
		requestId: input.requestId,
		inputDigest: "",
		previousCheckpointDigest: "",
		resultDigest: "",
		kind: "advanced",
		outcome: "accepted",
		checkpoint: checkpointFixture(),
		effects: [
			{
				kind: "predicate",
				predicateId: "trust",
				firstAgentId: "sol",
				secondAgentId: "lina",
				previous: 0,
				next: 1,
			},
		],
		trace: {
			rootActionId: "greet",
			terminalActionId: "greet-yes",
			bindings: {},
			candidateIds: [],
			triggerIds: [],
			drawsBefore: 0,
			drawsAfter: 0,
			rejection: null,
		},
	};
	const commit = socialResolutionCommit(input, result);
	expect(commit.world.audience).toEqual(["lina", "mira"]);
	expect(commit.experiences.find((x) => x.agentId === "sol")?.channel).toBe(
		"inferred",
	);
});
