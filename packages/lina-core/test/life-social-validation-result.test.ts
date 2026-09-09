import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import { initialLifeState } from "../src/world/life-transition.ts";
import { validateSocialResult } from "../src/world/social.ts";
import { socialRecord } from "../src/world/social-checkpoint-validation.ts";
import {
	decodeSocialValue,
	encodeSocialValue,
} from "../src/world/social-codec.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import type {
	SocialResolution,
	SocialResolveInput,
} from "../src/world/social-types.ts";
import { parseSocialResolveInput } from "../src/world/social-validation.ts";
import { initialSnapshot } from "../src/world/transition.ts";
import { identityPolicy, required } from "./life-fixture.ts";
import { socialIntent, socialPack } from "./life-social-pack-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";

function resolvedCheckpoint() {
	const checkpoint = checkpointFixture();
	// Hand-worked bootstrap: three resource cells, then six directed trust cells.
	const history: Record<string, unknown>[] = [];
	for (const first of ["lina", "mira", "sol"])
		history.push({
			category: "p_636f696e73",
			type: "value",
			first,
			second: undefined,
			origin: "lina-bootstrap",
			value: 5,
			id: history.length + 1,
			timeHappened: 0,
			duration: undefined,
		});
	for (const first of ["lina", "mira", "sol"])
		for (const second of ["lina", "mira", "sol"])
			if (first !== second)
				history.push({
					category: "p_7472757374",
					type: "value",
					first,
					second,
					origin: "lina-bootstrap",
					value: 0,
					id: history.length + 1,
					timeHappened: 0,
					duration: undefined,
				});
	const next = structuredClone(history);
	Object.assign(required(next[3]), { value: 1, id: 10, timeHappened: 1 });
	checkpoint.data.state.history = encodeSocialValue([history, next]);
	checkpoint.data.state.iterators["socialRecords"] = 10;
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	return checkpoint;
}
export function resolutionFixture(): {
	input: SocialResolveInput;
	result: SocialResolution;
} {
	const pack = socialPack(),
		world = initialSnapshot(pack.world),
		life = initialLifeState(world, pack.life),
		intent = socialIntent();
	const bootstrap = {
		version: 1 as const,
		worldId: pack.worldId,
		algorithm: "lcg32-v1" as const,
		seed: 42,
	};
	const input: SocialResolveInput = {
		version: 1,
		requestId: "social-request",
		world,
		life,
		identity: identityPolicy(),
		checkpoint: life.checkpoint,
		rulePack: compileSocialPack(pack),
		intent,
		targetResponse: {
			intentId: intent.id,
			agentId: "mira",
			decision: "accept",
		},
		simulationTime: 1,
		bootstrap: { ...bootstrap, digest: lifeDigest(bootstrap) },
		policies: [],
		limits: {
			maxOperations: 10000,
			maxBindings: 1000,
			maxDepth: 12,
			maxBytes: 1000000,
			maxHistoryEntries: 4096,
			maxTraceEntries: 100,
		},
	};
	const body = {
		version: 1 as const,
		requestId: input.requestId,
		inputDigest: lifeDigest(input),
		previousCheckpointDigest: lifeDigest(input.checkpoint),
		kind: "advanced" as const,
		outcome: "accepted" as const,
		effects: [
			{
				kind: "predicate" as const,
				predicateId: "trust",
				firstAgentId: "lina",
				secondAgentId: "mira",
				previous: 0,
				next: 1,
			},
		],
		checkpoint: resolvedCheckpoint(),
		trace: {
			rootActionId: "greet",
			terminalActionId: "greet-yes",
			bindings: { initiator: "lina", responder: "mira" },
			candidateIds: ["greet-yes"],
			triggerIds: [],
			drawsBefore: 0,
			drawsAfter: 1,
			rejection: null,
		},
	};
	return { input, result: { ...body, resultDigest: lifeDigest(body) } };
}
function sign(result: SocialResolution): void {
	const { resultDigest: _, ...body } = result;
	result.resultDigest = lifeDigest(body);
}
test("checks result against source, actual changes, root and RNG continuity", () => {
	const { input, result } = resolutionFixture();
	expect(parseSocialResolveInput(input)).toEqual(input);
	expect(validateSocialResult(input, result)).toEqual(result);
	for (const kind of ["effect", "root", "rng", "bound", "identity"]) {
		const pair = resolutionFixture();
		if (kind === "effect") pair.result.effects = [];
		if (kind === "root") pair.result.trace.rootActionId = "other";
		if (kind === "rng" && pair.result.checkpoint.engineId === "ensemble") {
			pair.result.checkpoint.data.rng.state = 0;
			pair.result.checkpoint.dataDigest = lifeDigest(
				pair.result.checkpoint.data,
			);
		}
		if (kind === "bound" && pair.result.checkpoint.engineId === "ensemble") {
			pair.result.checkpoint.data.worldRevision = 2;
			pair.result.checkpoint.dataDigest = lifeDigest(
				pair.result.checkpoint.data,
			);
		}
		if (kind === "identity") {
			required(pair.input.identity.profiles[0]).lockedAttitudeIds = [
				"relation",
			];
			pair.result.inputDigest = lifeDigest(pair.input);
		}
		sign(pair.result);
		expect(() => validateSocialResult(pair.input, pair.result)).toThrow();
	}
});
test("reveals require effective current policy and actual prior knowledge", () => {
	const { input } = resolutionFixture();
	input.intent.primitives.push({
		kind: "reveal",
		claim: { kind: "world_fact", id: "private" },
		toAgentId: "mira",
	});
	input.world.facts.push({
		id: "private",
		text: "Only Lina knows",
		knownTo: ["lina"],
		sourceEventId: null,
	});
	expect(() => parseSocialResolveInput(input)).toThrow(/disclosure/);
});
test("trusted world snapshot preserves append and audience ordering", () => {
	const { input } = resolutionFixture();
	input.world.facts = [
		{
			id: "z-last",
			text: "First event",
			knownTo: ["sol", "lina"],
			sourceEventId: null,
		},
		{
			id: "a-first",
			text: "Second event",
			knownTo: ["mira"],
			sourceEventId: null,
		},
	];
	required(input.world.scenes[0]).occupants = ["mira", "lina"];
	expect(parseSocialResolveInput(input).world).toEqual(input.world);
});
test("rejected attempts cannot smuggle successful move effects", () => {
	const { input, result } = resolutionFixture();
	if (result.kind !== "advanced") throw Error("fixture");
	result.outcome = "rejected";
	result.trace.rejection = "no_eligible_terminal";
	result.effects.push({ kind: "move", agentId: "lina", sceneId: "square" });
	sign(result);
	expect(() => validateSocialResult(input, result)).toThrow();
});
test("a valid checkpoint delta cannot redirect a declared actor effect to another agent", () => {
	const { input, result } = resolutionFixture();
	if (result.checkpoint.engineId !== "ensemble" || result.kind !== "advanced")
		throw Error("fixture");
	const history = decodeSocialValue(
		result.checkpoint.data.state.history,
	) as unknown[][];
	const redirected = required(
		required(history[1])
			.map(socialRecord)
			.find(
				(r) =>
					r["category"] === "p_7472757374" &&
					r["first"] === "sol" &&
					r["second"] === "mira",
			),
	);
	Object.assign(redirected, { value: 1, id: 11, timeHappened: 1 });
	result.checkpoint.data.state.history = encodeSocialValue(history);
	result.checkpoint.data.state.iterators["socialRecords"] = 11;
	result.checkpoint.dataDigest = lifeDigest(result.checkpoint.data);
	result.effects.push({
		kind: "predicate",
		predicateId: "trust",
		firstAgentId: "sol",
		secondAgentId: "mira",
		previous: 0,
		next: 1,
	});
	sign(result);
	expect(() => validateSocialResult(input, result)).toThrow();
});
