import {
	array,
	digest,
	enumeration,
	eventReference,
	finite,
	flag,
	identifier,
	identifiers,
	keyed,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import type {
	AgentBelief,
	AgentExperience,
	ClaimRef,
	DisclosurePolicy,
	DisclosureSubject,
	EngineCheckpoint,
	GrowthDelta,
	KnowledgeGrant,
	LifeClaim,
	SideEffectIntent,
} from "./life-types.ts";
import { parseEnsembleCheckpoint } from "./social-checkpoint-validation.ts";
import { fields, text } from "./validation.ts";

export function parseClaimRef(value: unknown): ClaimRef {
	fields(value, ["kind", "id"]);
	return {
		kind: enumeration(value.kind, ["world_fact", "life_claim"]),
		id: identifier(value.id),
	};
}
export function parseDisclosureSubject(value: unknown): DisclosureSubject {
	fields(value, ["kind", "id"]);
	const kind = enumeration(value.kind, [
		"world_event",
		"world_scene",
		"world_fact",
		"life_claim",
	]);
	return {
		kind,
		id:
			kind === "world_event" ? eventReference(value.id) : identifier(value.id),
	};
}
export function refKey(ref: { kind: string; id: string }): string {
	return `${ref.kind}:${ref.id}`;
}
export function parseDisclosurePolicy(value: unknown): DisclosurePolicy {
	fields(value, ["knowers", "disclosures", "publication"]);
	return {
		knowers: identifiers(value.knowers),
		disclosures: keyed(
			array(value.disclosures, (item) => {
				fields(item, ["agentId", "recipientId"]);
				return {
					agentId: identifier(item.agentId),
					recipientId: identifier(item.recipientId),
				};
			}),
			(x) => `${x.agentId}:${x.recipientId}`,
		),
		publication: identifiers(value.publication),
	};
}
export function parseClaim(value: unknown): LifeClaim {
	fields(value, [
		"id",
		"text",
		"sourceEventId",
		"truth",
		"supersedes",
		"disclosure",
	]);
	text(value.text, "LIFE claim");
	return {
		id: identifier(value.id),
		text: value.text,
		sourceEventId: eventReference(value.sourceEventId),
		truth: enumeration(value.truth, ["true", "false", "unknown"]),
		supersedes: nullableId(value.supersedes),
		disclosure: parseDisclosurePolicy(value.disclosure),
	};
}
export function parseKnowledgeGrant(value: unknown): KnowledgeGrant {
	fields(value, [
		"id",
		"claim",
		"fromAgentId",
		"toAgentId",
		"sourceEventId",
		"experienceId",
		"lifeRevision",
		"definitionRevision",
		"projectionRevision",
		"policyDigest",
	]);
	const grant: KnowledgeGrant = {
		id: identifier(value.id),
		claim: parseClaimRef(value.claim),
		fromAgentId: identifier(value.fromAgentId),
		toAgentId: identifier(value.toAgentId),
		sourceEventId: eventReference(value.sourceEventId),
		experienceId: identifier(value.experienceId),
		lifeRevision: revision(value.lifeRevision, 1),
		definitionRevision: revision(value.definitionRevision, 1),
		projectionRevision: revision(value.projectionRevision, 1),
		policyDigest: digest(value.policyDigest),
	};
	if (grant.fromAgentId === grant.toAgentId)
		throw Error("LIFE grant requires another recipient");
	return grant;
}
export function parseBelief(value: unknown): AgentBelief {
	fields(value, [
		"id",
		"agentId",
		"claim",
		"stance",
		"confidence",
		"experienceIds",
		"supersedes",
	]);
	const experienceIds = identifiers(value.experienceIds);
	if (!experienceIds.length) throw Error("LIFE belief requires evidence");
	return {
		id: identifier(value.id),
		agentId: identifier(value.agentId),
		claim: parseClaimRef(value.claim),
		stance: enumeration(value.stance, ["believes", "disbelieves", "uncertain"]),
		confidence: enumeration(value.confidence, [
			"uncertain",
			"likely",
			"certain",
		]),
		experienceIds,
		supersedes: nullableId(value.supersedes),
	};
}
export function parseExperience(value: unknown): AgentExperience {
	fields(value, [
		"id",
		"agentId",
		"eventId",
		"channel",
		"claims",
		"simulationTime",
	]);
	return {
		id: identifier(value.id),
		agentId: identifier(value.agentId),
		eventId: eventReference(value.eventId),
		channel: enumeration(value.channel, [
			"direct",
			"observed",
			"told",
			"inferred",
		]),
		claims: keyed(array(value.claims, parseClaimRef), refKey),
		simulationTime: revision(value.simulationTime),
	};
}
export function growthKey(delta: GrowthDelta): string {
	if (delta.kind === "attitude")
		return `${delta.kind}:${delta.fromAgentId}:${delta.toAgentId}:${delta.axisId}`;
	return `${delta.kind}:${delta.agentId}:${delta.kind === "habit" ? delta.habitId : delta.axisId}`;
}
export function growthAgent(delta: GrowthDelta): string {
	return delta.kind === "attitude" ? delta.fromAgentId : delta.agentId;
}
export function parseGrowth(value: unknown): GrowthDelta {
	if (!value || typeof value !== "object" || !("kind" in value))
		throw Error("Invalid LIFE growth");
	const kind = enumeration(value.kind, ["trait", "habit", "attitude"]);
	if (kind === "attitude") {
		fields(value, [
			"kind",
			"fromAgentId",
			"toAgentId",
			"axisId",
			"previous",
			"next",
			"evidenceIds",
		]);
		const evidenceIds = identifiers(value.evidenceIds);
		if (!evidenceIds.length) throw Error("LIFE growth requires evidence");
		return {
			kind,
			fromAgentId: identifier(value.fromAgentId),
			toAgentId: identifier(value.toAgentId),
			axisId: identifier(value.axisId),
			previous: finite(value.previous),
			next: finite(value.next),
			evidenceIds,
		};
	}
	if (kind === "habit") {
		fields(value, [
			"kind",
			"agentId",
			"habitId",
			"previous",
			"next",
			"evidenceIds",
		]);
		const evidenceIds = identifiers(value.evidenceIds);
		if (!evidenceIds.length) throw Error("LIFE growth requires evidence");
		return {
			kind,
			agentId: identifier(value.agentId),
			habitId: identifier(value.habitId),
			previous: flag(value.previous),
			next: flag(value.next),
			evidenceIds,
		};
	}
	fields(value, [
		"kind",
		"agentId",
		"axisId",
		"previous",
		"next",
		"evidenceIds",
	]);
	const evidenceIds = identifiers(value.evidenceIds);
	if (!evidenceIds.length) throw Error("LIFE growth requires evidence");
	return {
		kind,
		agentId: identifier(value.agentId),
		axisId: identifier(value.axisId),
		previous: finite(value.previous),
		next: finite(value.next),
		evidenceIds,
	};
}
export function emptyCheckpoint(): EngineCheckpoint {
	return {
		version: 1,
		engineId: "empty",
		engineRevision: 0,
		ruleDigest: lifeDigest(null),
		encodingVersion: 1,
		dataDigest: lifeDigest(null),
		data: null,
	};
}
export function parseCheckpoint(value: unknown): EngineCheckpoint {
	if (
		value &&
		typeof value === "object" &&
		"engineId" in value &&
		value.engineId === "ensemble"
	)
		return parseEnsembleCheckpoint(value);
	fields(value, [
		"version",
		"engineId",
		"engineRevision",
		"ruleDigest",
		"encodingVersion",
		"dataDigest",
		"data",
	]);
	if (
		value.version !== 1 ||
		value.engineId !== "empty" ||
		value.engineRevision !== 0 ||
		value.encodingVersion !== 1 ||
		value.data !== null
	)
		throw Error("Unsupported LIFE checkpoint");
	if (
		digest(value.ruleDigest) !== lifeDigest(null) ||
		digest(value.dataDigest) !== lifeDigest(value.data)
	)
		throw Error("LIFE checkpoint digest mismatch");
	return emptyCheckpoint();
}
export function parseEffect(value: unknown): SideEffectIntent {
	fields(value, [
		"version",
		"worldId",
		"id",
		"lifeRevision",
		"payload",
		"payloadDigest",
	]);
	if (value.version !== 1) throw Error("Unsupported LIFE intent version");
	fields(value.payload, ["kind", "eventId"]);
	const payload = {
		kind: enumeration(value.payload.kind, ["publication_candidate"]),
		eventId: eventReference(value.payload.eventId),
	};
	if (digest(value.payloadDigest) !== lifeDigest(payload))
		throw Error("LIFE intent digest mismatch");
	return {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		lifeRevision: revision(value.lifeRevision, 1),
		payload,
		payloadDigest: digest(value.payloadDigest),
	};
}
