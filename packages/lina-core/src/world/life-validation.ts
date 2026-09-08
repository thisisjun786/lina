import {
	array,
	digest,
	enumeration,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import {
	growthKey,
	parseBelief,
	parseCheckpoint,
	parseClaim,
	parseDisclosurePolicy,
	parseDisclosureSubject,
	parseEffect,
	parseExperience,
	parseGrowth,
	parseKnowledgeGrant,
	refKey,
} from "./life-record-validation.ts";
import type {
	AuthorScope,
	BindingSelection,
	LifeCommit,
	LifeCommitV1,
	LifeDefinition,
	LifeInput,
	LifeViewLimits,
	NumericAxis,
	PerceptionScope,
	ProjectionPolicy,
	PublicationScope,
	WorldBinding,
} from "./life-types.ts";
import {
	parsePublicationInputSource,
	publicationObservationId,
} from "./publication-input.ts";
import {
	fields,
	knownAgents,
	MAX_WORLD_BYTES,
	parseProposal,
	text,
} from "./validation.ts";
import { parseWorkInputSource } from "./work-validation.ts";

export { canonicalLifeJson, lifeDigest } from "./life-json.ts";

function version(value: unknown): 1 {
	if (value !== 1) throw Error("Unsupported LIFE version");
	return 1;
}
function axis(value: unknown): NumericAxis {
	fields(value, ["id", "label", "min", "max", "initial"]);
	text(value.label, "LIFE public label");
	const result = {
		id: identifier(value.id),
		label: value.label,
		min: finite(value.min),
		max: finite(value.max),
		initial: finite(value.initial),
	};
	if (
		result.min > result.max ||
		result.initial < result.min ||
		result.initial > result.max
	)
		throw Error("Invalid LIFE axis bounds");
	return result;
}
export function parseProjectionPolicy(value: unknown): ProjectionPolicy {
	jsonBoundary(value);
	fields(value, [
		"revision",
		"sharedTraitIds",
		"sharedHabitIds",
		"sharedAttitudeIds",
		"disclosures",
	]);
	return {
		revision: revision(value.revision, 1),
		sharedTraitIds: identifiers(value.sharedTraitIds),
		sharedHabitIds: identifiers(value.sharedHabitIds),
		sharedAttitudeIds: identifiers(value.sharedAttitudeIds),
		disclosures: keyed(
			array(value.disclosures, (entry) => {
				fields(entry, ["subject", "policy"]);
				return {
					subject: parseDisclosureSubject(entry.subject),
					policy: parseDisclosurePolicy(entry.policy),
				};
			}),
			(entry) => refKey(entry.subject),
		),
	};
}
export function parseLifeDefinition(value: unknown): LifeDefinition {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"revision",
		"participants",
		"traits",
		"habits",
		"attitudes",
		"projection",
	]);
	const result: LifeDefinition = {
		version: version(value.version),
		worldId: identifier(value.worldId),
		revision: revision(value.revision, 1),
		participants: identifiers(value.participants),
		traits: keyed(array(value.traits, axis), (x) => x.id),
		habits: keyed(
			array(value.habits, (entry) => {
				fields(entry, ["id", "label", "initial"]);
				text(entry.label, "LIFE habit label");
				return {
					id: identifier(entry.id),
					label: entry.label,
					initial: flag(entry.initial),
				};
			}),
			(x) => x.id,
		),
		attitudes: keyed(array(value.attitudes, axis), (x) => x.id),
		projection: parseProjectionPolicy(value.projection),
	};
	for (const [allowed, axes] of [
		[result.projection.sharedTraitIds, result.traits],
		[result.projection.sharedHabitIds, result.habits],
		[result.projection.sharedAttitudeIds, result.attitudes],
	] as const) {
		if (allowed.some((key) => !axes.some((item) => item.id === key)))
			throw Error("Unknown LIFE shared axis");
	}
	for (const entry of result.projection.disclosures) {
		knownAgents(entry.policy.knowers, result.participants);
		knownAgents(
			entry.policy.disclosures.map((x) => x.agentId),
			result.participants,
		);
	}
	return result;
}
export { parseIdentityPolicy } from "./identity-policy.ts";
export function parseLifeCommit(value: unknown): LifeCommit {
	jsonBoundary(value);
	const current =
		!!value &&
		typeof value === "object" &&
		"version" in value &&
		(value["version"] === 2 || value["version"] === 3);
	const autonomous = current && value["version"] === 3;
	fields(value, [
		"version",
		"world",
		"expectedLifeRevision",
		"definitionRevision",
		"claims",
		"beliefs",
		"experiences",
		"growth",
		"checkpoint",
		"consumedInputIds",
		"effects",
		...(current ? ["socialResolutionId", "knowledgeGrants"] : []),
		...(autonomous ? ["stepId"] : []),
	]);
	const world = parseProposal(value["world"]);
	world.actorIds.sort();
	world.audience.sort();
	for (const fact of world.facts) fact.knownTo.sort();
	const legacy: LifeCommitV1 = {
		version: current ? 1 : version(value["version"]),
		world,
		expectedLifeRevision: revision(value["expectedLifeRevision"]),
		definitionRevision: revision(value["definitionRevision"], 1),
		claims: keyed(array(value["claims"], parseClaim), (x) => x.id, false),
		beliefs: keyed(array(value["beliefs"], parseBelief), (x) => x.id, false),
		experiences: keyed(
			array(value["experiences"], parseExperience),
			(x) => x.id,
			false,
		),
		growth: keyed(array(value["growth"], parseGrowth), growthKey, false),
		checkpoint: parseCheckpoint(value["checkpoint"]),
		consumedInputIds: identifiers(value["consumedInputIds"]),
		effects: keyed(array(value["effects"], parseEffect), (x) => x.id),
	};
	if (!current) {
		if (legacy.checkpoint.engineId !== "empty")
			throw Error("Legacy LIFE commit cannot contain an ensemble checkpoint");
		return legacy;
	}
	const knowledgeGrants = keyed(
		array(value["knowledgeGrants"], parseKnowledgeGrant),
		(x) => x.id,
		false,
	);
	return autonomous
		? {
				...legacy,
				version: 3,
				stepId: identifier(value["stepId"]),
				socialResolutionId: nullableId(value["socialResolutionId"]),
				knowledgeGrants,
			}
		: {
				...legacy,
				version: 2,
				socialResolutionId: identifier(value["socialResolutionId"]),
				knowledgeGrants,
			};
}
export function parseLifeInput(value: unknown): LifeInput {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"sourceRevision",
		"payloadDigest",
		"source",
		"consumedLifeRevision",
	]);
	if (value.version === 3) {
		const source = parsePublicationInputSource(value.source),
			worldId = identifier(value.worldId),
			id = identifier(value.id);
		if (
			id !== source.observationId ||
			id !==
				publicationObservationId(
					worldId,
					source.interactionId,
					source.recipientAgentId,
				) ||
			value.sourceRevision !== 1 ||
			digest(value.payloadDigest) !== lifeDigest(source)
		)
			throw Error("LIFE publication observation identity or digest mismatch");
		return {
			version: 3,
			worldId,
			id,
			sourceRevision: 1,
			payloadDigest: digest(value.payloadDigest),
			source,
			consumedLifeRevision:
				value.consumedLifeRevision === null
					? null
					: revision(value.consumedLifeRevision, 1),
		};
	}
	if (value.version === 2) {
		const source = parseWorkInputSource(value.source);
		if (
			digest(value.payloadDigest) !== lifeDigest(source) ||
			value.id !== source.deliveryId ||
			value.sourceRevision !== source.receipt.receiptRevision
		)
			throw Error("LIFE work input identity or digest mismatch");
		return {
			version: 2,
			worldId: identifier(value.worldId),
			id: identifier(value.id),
			sourceRevision: revision(value.sourceRevision, 1),
			payloadDigest: digest(value.payloadDigest),
			source,
			consumedLifeRevision:
				value.consumedLifeRevision === null
					? null
					: revision(value.consumedLifeRevision, 1),
		};
	}
	fields(value.source, ["kind", "sourceId", "text"]);
	text(value.source.text, "LIFE application input");
	const source = {
		kind: enumeration(value.source.kind, ["application"]),
		sourceId: identifier(value.source.sourceId),
		text: value.source.text,
	};
	if (digest(value.payloadDigest) !== lifeDigest(source))
		throw Error("LIFE input digest mismatch");
	return {
		version: version(value.version),
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		sourceRevision: revision(value.sourceRevision),
		payloadDigest: digest(value.payloadDigest),
		source,
		consumedLifeRevision:
			value.consumedLifeRevision === null
				? null
				: revision(value.consumedLifeRevision, 1),
	};
}

export function parseBindingSelection(value: unknown): BindingSelection {
	jsonBoundary(value);
	const v2 =
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 2;
	fields(value, [
		"worldId",
		"projectionPolicyRevision",
		...(v2 ? ["version", "conversationRecipientId"] : []),
	]);
	const worldId = nullableId(value["worldId"]),
		projectionPolicyRevision = revision(value["projectionPolicyRevision"]);
	if (
		worldId === null
			? projectionPolicyRevision !== 0
			: projectionPolicyRevision === 0
	)
		throw Error("Invalid LIFE binding policy revision");
	if (!v2) return { worldId, projectionPolicyRevision };
	const conversationRecipientId = nullableId(value["conversationRecipientId"]);
	if (worldId === null && conversationRecipientId !== null)
		throw Error("Unbound ordinary recipient");
	return {
		version: 2,
		worldId,
		projectionPolicyRevision,
		conversationRecipientId,
	};
}
export function parseWorldBinding(value: unknown): WorldBinding {
	jsonBoundary(value);
	const v2 =
		typeof value === "object" &&
		value !== null &&
		"version" in value &&
		value.version === 2;
	fields(value, [
		"version",
		"agentId",
		"worldId",
		"revision",
		"projectionPolicyRevision",
		...(v2 ? ["conversationRecipientId"] : []),
	]);
	const common = {
		agentId: identifier(value["agentId"]),
		revision: revision(value["revision"], 1),
	};
	const selection = parseBindingSelection({
		worldId: value["worldId"],
		projectionPolicyRevision: value["projectionPolicyRevision"],
		...(v2
			? {
					version: 2,
					conversationRecipientId: value["conversationRecipientId"],
				}
			: {}),
	});
	if ("version" in selection) return { ...selection, ...common };
	return { version: version(value["version"]), ...selection, ...common };
}
export function parseLifeViewLimits(value: unknown): LifeViewLimits {
	jsonBoundary(value);
	fields(value, ["maxChars", "maxRecords"]);
	const maxChars = revision(value.maxChars, 1);
	const maxRecords = revision(value.maxRecords);
	if (maxChars > MAX_WORLD_BYTES || maxRecords > 4096)
		throw Error("Invalid LIFE view budget");
	return { maxChars, maxRecords };
}
export function parseAuthorScope(value: unknown): AuthorScope {
	jsonBoundary(value);
	fields(value, ["purpose", "worldId"]);
	return {
		purpose: enumeration(value.purpose, ["author"]),
		worldId: identifier(value.worldId),
	};
}
export function parsePerceptionScope(value: unknown): PerceptionScope {
	jsonBoundary(value);
	fields(value, ["purpose", "worldId", "agentId"]);
	return {
		purpose: enumeration(value.purpose, ["life"]),
		worldId: identifier(value.worldId),
		agentId: identifier(value.agentId),
	};
}
export function parsePublicationScope(value: unknown): PublicationScope {
	jsonBoundary(value);
	fields(value, ["purpose", "worldId", "agentId", "recipientId"]);
	return {
		purpose: enumeration(value.purpose, ["publication"]),
		worldId: identifier(value.worldId),
		agentId: identifier(value.agentId),
		recipientId: identifier(value.recipientId),
	};
}

export { parseLifeState } from "./life-state-validation.ts";
