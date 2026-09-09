import { authoringText } from "./authoring-node-validation.ts";
import {
	array,
	digest,
	enumeration,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { currentDisclosurePolicy, knowsClaimAt } from "./life-knowledge.ts";
import { parseCheckpoint, parseClaimRef } from "./life-record-validation.ts";
import { parseLifeState } from "./life-state-validation.ts";
import { parseIdentityPolicy } from "./life-validation.ts";
import { assertSocialCapacity } from "./social-capacity.ts";
import {
	parseEnsembleCheckpoint,
	socialRecord,
} from "./social-checkpoint-validation.ts";
import { parseCompiledSocialPack } from "./social-compile.ts";
import { socialValue } from "./social-definition-validation.ts";
import { inspectSocialIntent } from "./social-intent-validation.ts";
import {
	parseSocialStoreLimits,
	parseSocialTargetResponse,
} from "./social-store-validation.ts";
import type {
	SocialBootstrap,
	SocialDecisionTrace,
	SocialEffect,
	SocialPolicyReference,
	SocialResolution,
	SocialResolveInput,
	SocialResolveInputV1,
} from "./social-types.ts";
import { parseSocialAutonomyInput } from "./social-variables.ts";
import { assertSocialSource, projectSocialActorView } from "./social-views.ts";
import type { WorldSnapshot } from "./types.ts";
import {
	fields,
	integer,
	knownAgents,
	parseDefinition,
	unique,
} from "./validation.ts";

function worldSnapshot(value: unknown): WorldSnapshot {
	fields(value, [
		"definition",
		"revision",
		"simulationTime",
		"scenes",
		"facts",
	]);
	const definition = parseDefinition(value.definition);
	const scenes = parseDefinition({
		...definition,
		scenes: value.scenes,
	}).scenes;
	const facts = keyed(
		array(value.facts, (fact) => {
			fields(fact, ["id", "text", "knownTo", "sourceEventId"]);
			const knownTo = keyed(array(fact.knownTo, identifier), (id) => id, false);
			knownAgents(knownTo, definition.agents);
			if (!knownTo.length) throw Error("Invalid social fact knowledge");
			let sourceEventId: string | null = null;
			if (fact.sourceEventId !== null) {
				if (
					typeof fact.sourceEventId !== "string" ||
					!fact.sourceEventId.startsWith(`${definition.id}:`)
				)
					throw Error("Invalid social fact event");
				const suffix = fact.sourceEventId.slice(definition.id.length + 1);
				if (
					!/^[1-9][0-9]*$/.test(suffix) ||
					Number(suffix) > revision(value.revision)
				)
					throw Error("Invalid social fact event revision");
				sourceEventId = fact.sourceEventId;
			}
			return {
				id: identifier(fact.id),
				text: authoringText(fact.text),
				knownTo,
				sourceEventId,
			};
		}),
		(f) => f.id,
		false,
	);
	return {
		definition,
		revision: revision(value.revision),
		simulationTime: revision(value.simulationTime),
		scenes,
		facts,
	};
}

function bootstrap(value: unknown): SocialBootstrap {
	fields(value, ["version", "worldId", "algorithm", "seed", "digest"]);
	if (value.version !== 1 || value.algorithm !== "lcg32-v1")
		throw Error("Unsupported social bootstrap");
	integer(value.seed, "social seed", 0, 0xffffffff);
	const body = {
		version: 1 as const,
		worldId: identifier(value.worldId),
		algorithm: "lcg32-v1" as const,
		seed: value.seed,
	};
	if (digest(value.digest) !== lifeDigest(body))
		throw Error("Social bootstrap digest mismatch");
	return { ...body, digest: digest(value.digest) };
}
function policyReference(value: unknown): SocialPolicyReference {
	fields(value, [
		"claim",
		"definitionRevision",
		"projectionRevision",
		"policyDigest",
	]);
	return {
		claim: parseClaimRef(value.claim),
		definitionRevision: revision(value.definitionRevision, 1),
		projectionRevision: revision(value.projectionRevision, 1),
		policyDigest: digest(value.policyDigest),
	};
}

export function parseSocialResolveInput(value: unknown): SocialResolveInput {
	jsonBoundary(value);
	const autonomous =
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 2;
	fields(value, [
		"version",
		"requestId",
		"world",
		"life",
		"identity",
		"checkpoint",
		"rulePack",
		"intent",
		"targetResponse",
		"simulationTime",
		"bootstrap",
		"policies",
		"limits",
		...(autonomous ? (["autonomy"] as const) : []),
	]);
	if (value.version !== 1 && !autonomous)
		throw Error("Unsupported social input version");
	const rulePack = parseCompiledSocialPack(value.rulePack),
		inspection = inspectSocialIntent(value.intent, rulePack);
	if (inspection.kind !== "intent")
		throw Error("Social extension cannot dispatch");
	const targetResponse = parseSocialTargetResponse(value.targetResponse);
	const legacy: SocialResolveInputV1 = {
		version: 1,
		requestId: identifier(value.requestId),
		world: worldSnapshot(value.world),
		life: parseLifeState(value.life),
		identity: parseIdentityPolicy(value.identity),
		checkpoint: parseCheckpoint(value.checkpoint),
		rulePack,
		intent: inspection.intent,
		targetResponse,
		simulationTime: revision(value.simulationTime),
		bootstrap: value.bootstrap === null ? null : bootstrap(value.bootstrap),
		policies: keyed(
			array(value.policies, policyReference),
			(p) => `${p.claim.kind}:${p.claim.id}`,
		),
		limits: parseSocialStoreLimits(value.limits),
	};
	const result: SocialResolveInput = autonomous
		? {
				...legacy,
				version: 2,
				autonomy: parseSocialAutonomyInput(value.autonomy, legacy),
			}
		: legacy;
	assertSocialSource(rulePack, result.world, result.life);
	assertSocialCapacity(rulePack, result.checkpoint, result.limits);
	if (
		lifeDigest(result.checkpoint) !== lifeDigest(result.life.checkpoint) ||
		result.simulationTime < result.world.simulationTime
	)
		throw Error("Social checkpoint source mismatch");
	if (
		result.checkpoint.engineId === "empty"
			? !result.bootstrap || result.bootstrap.worldId !== rulePack.worldId
			: result.bootstrap !== null
	)
		throw Error("Social bootstrap boundary mismatch");
	if (result.checkpoint.engineId === "ensemble") {
		const data = result.checkpoint.data;
		if (
			data.worldId !== rulePack.worldId ||
			data.packVersion !== rulePack.packVersion ||
			data.worldRevision !== result.world.revision ||
			data.lifeRevision !== result.life.revision ||
			data.simulationTime !== result.world.simulationTime ||
			data.schemaDigest !== rulePack.schemaDigest ||
			data.actionDigest !== rulePack.actionDigest ||
			result.checkpoint.ruleDigest !== rulePack.ruleDigest
		)
			throw Error("Social checkpoint boundary mismatch");
	}
	if (
		inspection.intent.targetAgentId !== null
			? !targetResponse ||
				targetResponse.agentId !== inspection.intent.targetAgentId ||
				targetResponse.intentId !== inspection.intent.id
			: targetResponse !== null
	)
		throw Error("Social target response mismatch");
	if (
		!projectSocialActorView(
			rulePack,
			result.world,
			result.life,
			result.intent.agentId,
			result.intent.targetAgentId,
		).capabilities.some((c) => c.id === result.intent.capabilityId)
	)
		throw Error("Unavailable social capability");
	const claimKeys: string[] = [];
	for (const primitive of result.intent.primitives) {
		if (
			primitive.kind === "move" &&
			!result.world.scenes.some((s) => s.id === primitive.sceneId)
		)
			throw Error("Unknown social move destination");
		if (primitive.kind !== "reveal") continue;
		const key = `${primitive.claim.kind}:${primitive.claim.id}`;
		if (!claimKeys.includes(key)) claimKeys.push(key);
		const policy = currentDisclosurePolicy(primitive.claim, rulePack.life),
			ref = result.policies.find(
				(p) => `${p.claim.kind}:${p.claim.id}` === key,
			);
		if (
			!policy ||
			!ref ||
			ref.definitionRevision !== rulePack.life.revision ||
			ref.projectionRevision !== rulePack.life.projection.revision ||
			ref.policyDigest !== lifeDigest(policy) ||
			!policy.knowers.includes(result.intent.agentId) ||
			!policy.disclosures.some(
				(d) =>
					d.agentId === result.intent.agentId &&
					d.recipientId === primitive.toAgentId,
			) ||
			!knowsClaimAt(
				primitive.claim,
				result.intent.agentId,
				result.world,
				result.life,
			) ||
			knowsClaimAt(
				primitive.claim,
				primitive.toAgentId,
				result.world,
				result.life,
			)
		)
			throw Error("Social disclosure authority mismatch");
	}
	if (result.policies.length !== claimKeys.length)
		throw Error("Unexpected social policy reference");
	knownAgents(
		result.identity.profiles.map((p) => p.agentId),
		rulePack.life.participants,
	);
	if (result.identity.profiles.length !== rulePack.life.participants.length)
		throw Error("Incomplete social identity snapshot");
	if (Buffer.byteLength(JSON.stringify(result)) > result.limits.maxBytes)
		throw Error("Social input byte budget exceeded");
	return result;
}

function effect(value: unknown): SocialEffect {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid social result effect");
	switch (value.kind) {
		case "predicate":
			fields(value, [
				"kind",
				"predicateId",
				"firstAgentId",
				"secondAgentId",
				"previous",
				"next",
			]);
			return {
				kind: "predicate",
				predicateId: identifier(value.predicateId),
				firstAgentId: identifier(value.firstAgentId),
				secondAgentId: nullableId(value.secondAgentId),
				previous: socialValue(value.previous),
				next: socialValue(value.next),
			};
		case "move":
			fields(value, ["kind", "agentId", "sceneId"]);
			return {
				kind: "move",
				agentId: identifier(value.agentId),
				sceneId: identifier(value.sceneId),
			};
		case "reveal":
			fields(value, ["kind", "fromAgentId", "toAgentId", "claim"]);
			return {
				kind: "reveal",
				fromAgentId: identifier(value.fromAgentId),
				toAgentId: identifier(value.toAgentId),
				claim: parseClaimRef(value.claim),
			};
		case "goal":
			fields(value, ["kind", "agentId", "goalId", "description"]);
			return {
				kind: "goal",
				agentId: identifier(value.agentId),
				goalId: identifier(value.goalId),
				description: authoringText(value.description),
			};
		default:
			throw Error("Unsupported social result effect");
	}
}
function trace(value: unknown): SocialDecisionTrace {
	fields(value, [
		"rootActionId",
		"terminalActionId",
		"bindings",
		"candidateIds",
		"triggerIds",
		"drawsBefore",
		"drawsAfter",
		"rejection",
	]);
	const candidateIds = array(value.candidateIds, identifier),
		triggerIds = array(value.triggerIds, identifier);
	unique(candidateIds, "social candidates");
	unique(triggerIds, "social triggers");
	return {
		rootActionId: nullableId(value.rootActionId),
		terminalActionId: nullableId(value.terminalActionId),
		bindings: Object.fromEntries(
			Object.entries(socialRecord(value.bindings)).map(([k, v]) => [
				k,
				identifier(v),
			]),
		),
		candidateIds,
		triggerIds,
		drawsBefore: revision(value.drawsBefore),
		drawsAfter: revision(value.drawsAfter),
		rejection: value.rejection === null ? null : authoringText(value.rejection),
	};
}
export function parseSocialResolution(value: unknown): SocialResolution {
	jsonBoundary(value);
	fields(value, [
		"version",
		"requestId",
		"inputDigest",
		"previousCheckpointDigest",
		"resultDigest",
		"trace",
		"kind",
		"outcome",
		"effects",
		"checkpoint",
	]);
	if (value.version !== 1) throw Error("Unsupported social result version");
	const base = {
		version: 1 as const,
		requestId: identifier(value.requestId),
		inputDigest: digest(value.inputDigest),
		previousCheckpointDigest: digest(value.previousCheckpointDigest),
		resultDigest: digest(value.resultDigest),
		trace: trace(value.trace),
	};
	const effects = array(value.effects, effect);
	let result: SocialResolution;
	if (value.kind === "unchanged") {
		if (value.outcome !== "extension_required" || effects.length)
			throw Error("Invalid unchanged social result");
		result = {
			...base,
			kind: "unchanged",
			outcome: "extension_required",
			effects: [],
			checkpoint: parseCheckpoint(value.checkpoint),
		};
	} else if (value.kind === "advanced")
		result = {
			...base,
			kind: "advanced",
			outcome: enumeration(value.outcome, ["accepted", "rejected"]),
			effects,
			checkpoint: parseEnsembleCheckpoint(value.checkpoint),
		};
	else throw Error("Unsupported social result kind");
	const { resultDigest, ...body } = result;
	if (lifeDigest(body) !== resultDigest)
		throw Error("Social result digest mismatch");
	return result;
}
