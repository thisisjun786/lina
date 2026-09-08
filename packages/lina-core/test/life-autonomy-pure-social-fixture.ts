import { lifeDigest } from "../src/world/life-json.ts";
import { encodeSocialValue } from "../src/world/social-codec.ts";
import { compileSocialPack } from "../src/world/social-compile.ts";
import type { SocialPreparedResolution } from "../src/world/social-store-types.ts";
import type {
	SocialResolution,
	SocialResolveInputV2,
} from "../src/world/social-types.ts";
import {
	autonomySource,
	completedModel,
	pureStep,
	socialHistory,
} from "./life-autonomy-pure-fixture.ts";
import { required } from "./life-fixture.ts";
import { socialIntent } from "./life-social-pack-fixture.ts";
import { checkpointFixture } from "./life-social-validation-fixture.ts";
export function socialStep(
	options: {
		reveal?: boolean;
		privateConsequence?: boolean;
		acceptedCount?: number;
	} = {},
) {
	const source = autonomySource();
	source.autonomy.variables["count"] = options.acceptedCount ?? 1;
	if (options.reveal)
		source.pack.life.projection.disclosures.push({
			subject: { kind: "world_fact", id: "secret" },
			policy: {
				knowers: ["lina"],
				disclosures: [{ agentId: "lina", recipientId: "sol" }],
				publication: [],
			},
		});
	if (options.privateConsequence)
		source.pack.social.triggers.push({
			id: "private",
			bindings: [],
			conditions: [
				{
					predicateId: "trust",
					first: { kind: "agent", agentId: "lina" },
					second: { kind: "agent", agentId: "mira" },
					operator: "=",
					value: 1,
					window: null,
				},
			],
			effects: [
				{
					predicateId: "trust",
					first: { kind: "agent", agentId: "sol" },
					second: { kind: "agent", agentId: "lina" },
					operator: "+",
					value: 1,
				},
			],
		});
	const step = pureStep(source);
	step.intent = { ...socialIntent(), description: "ACTOR_PRIVATE_CANARY" };
	if (options.reveal)
		step.intent.primitives.push({
			kind: "reveal",
			claim: { kind: "world_fact", id: "secret" },
			toAgentId: "sol",
		});
	step.targetResponse = {
		intentId: step.intent.id,
		agentId: "mira",
		decision: "accept",
	};
	step.socialRequestId = "social-request";
	step.models = [
		completedModel(step, "director", "lina", "DIRECTOR_PRIVATE_CANARY"),
		completedModel(step, "actor", "lina", JSON.stringify(step.intent)),
		completedModel(step, "target", "mira", JSON.stringify(step.targetResponse)),
	];
	const bootstrap = {
		version: 1 as const,
		worldId: step.worldId,
		algorithm: "lcg32-v1" as const,
		seed: 42,
	};
	const compiled = compileSocialPack(source.pack);
	const input: SocialResolveInputV2 = {
		version: 2,
		requestId: step.socialRequestId,
		world: source.world,
		life: source.life,
		identity: source.identity,
		checkpoint: source.life.checkpoint,
		rulePack: compiled,
		intent: socialIntent(),
		targetResponse: step.targetResponse,
		simulationTime: 1,
		bootstrap: { ...bootstrap, digest: lifeDigest(bootstrap) },
		policies: options.reveal
			? [
					{
						claim: { kind: "world_fact", id: "secret" },
						definitionRevision: 1,
						projectionRevision: 1,
						policyDigest: lifeDigest(
							required(source.pack.life.projection.disclosures[0]).policy,
						),
					},
				]
			: [],
		limits: {
			maxOperations: 10000,
			maxBindings: 1000,
			maxDepth: 12,
			maxBytes: 1000000,
			maxHistoryEntries: 4096,
			maxTraceEntries: 100,
		},
		autonomy: {
			stepId: step.id,
			worldRevision: 0,
			lifeRevision: 0,
			stateDigest: lifeDigest(source.autonomy),
			variables: structuredClone(source.autonomy.variables),
		},
	};
	// No extension in this fixture: the exact saved actor text contains only known primitives.
	input.intent = JSON.parse(required(step.models[1]?.result ?? undefined).text);
	const checkpoint = checkpointFixture(),
		{ before, after } = socialHistory();
	checkpoint.ruleDigest = compiled.ruleDigest;
	checkpoint.data.schemaDigest = compiled.schemaDigest;
	checkpoint.data.actionDigest = compiled.actionDigest;
	checkpoint.data.variables = structuredClone(source.autonomy.variables);
	const effects: SocialResolution["effects"] = [
		{
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "lina",
			secondAgentId: "mira",
			previous: 0,
			next: 1,
		},
	];
	if (options.privateConsequence) {
		Object.assign(required(after[7]), { value: 1, id: 11, timeHappened: 1 });
		effects.push({
			kind: "predicate",
			predicateId: "trust",
			firstAgentId: "sol",
			secondAgentId: "lina",
			previous: 0,
			next: 1,
		});
	}
	if (options.reveal)
		effects.push({
			kind: "reveal",
			fromAgentId: "lina",
			toAgentId: "sol",
			claim: { kind: "world_fact", id: "secret" },
		});
	checkpoint.data.state.history = encodeSocialValue([before, after]);
	checkpoint.data.state.iterators["socialRecords"] = options.privateConsequence
		? 11
		: 10;
	checkpoint.data.state.iterators["rules"] = options.privateConsequence ? 1 : 0;
	checkpoint.dataDigest = lifeDigest(checkpoint.data);
	const body = {
		version: 1 as const,
		requestId: input.requestId,
		inputDigest: lifeDigest(input),
		previousCheckpointDigest: lifeDigest(input.checkpoint),
		kind: "advanced" as const,
		outcome: "accepted" as const,
		effects,
		checkpoint,
		trace: {
			rootActionId: "greet",
			terminalActionId: "greet-yes",
			bindings: { initiator: "lina", responder: "mira" },
			candidateIds: ["greet-yes"],
			triggerIds: options.privateConsequence ? ["private"] : [],
			drawsBefore: 0,
			drawsAfter: 1,
			rejection: null,
		},
	};
	const result: SocialResolution = { ...body, resultDigest: lifeDigest(body) };
	const social: SocialPreparedResolution = {
		version: 1,
		worldId: step.worldId,
		requestId: input.requestId,
		requestDigest: lifeDigest(input),
		inputDigest: lifeDigest(input),
		input,
		result,
		acceptedLifeRevision: null,
	};
	return { step, social };
}
