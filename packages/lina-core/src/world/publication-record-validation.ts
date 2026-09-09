import {
	digest,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	lifeDigest,
	nullableId,
	revision,
} from "./life-json.ts";
import { parseLifeModelSelection } from "./model-selection.ts";
import {
	parsePublicationAuthor,
	parsePublicationEventSource,
	parsePublicationMaterialFields,
} from "./publication-record-fields.ts";
import {
	parseReplyPublicationMaterial,
	publicationReplyJobId,
} from "./publication-reply-records.ts";

export { parsePublicationAuthor } from "./publication-record-fields.ts";
export { publicationReplyJobId } from "./publication-reply-records.ts";

import type {
	EventPublicationMaterial,
	PublicationJob,
	PublicationMaterial,
} from "./publication-types.ts";
import { parsePublicationDecision } from "./publication-validation.ts";
import { fields, text } from "./validation.ts";

function prose(value: unknown): string {
	text(value, "publication text");
	return value;
}
export function parsePublicationMaterial(value: unknown): PublicationMaterial {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 2
	)
		return parseReplyPublicationMaterial(value);
	return parseEventPublicationMaterial(value);
}
function parseEventPublicationMaterial(
	value: unknown,
): EventPublicationMaterial {
	jsonBoundary(value);
	fields(value, [
		"version",
		"id",
		"worldId",
		"authorAgentId",
		"source",
		"definitionRevision",
		"workRevision",
		"workAncestryRevision",
		"limits",
		"policyRevision",
		"configRevision",
		"settingsRevision",
		"workEvidenceDigest",
		"audience",
		"allowedClaims",
		"permittedScene",
		"digest",
	]);
	if (value.version !== 1)
		throw Error("Unsupported publication material version");
	fields(value.source, [
		"kind",
		"intentId",
		"eventId",
		"worldRevision",
		"lifeRevision",
	]);
	let scene: EventPublicationMaterial["permittedScene"] = null;
	if (value.permittedScene !== null) {
		const s = value.permittedScene;
		fields(s, ["id", "place", "description", "occupants"]);
		fields(s.place, ["id", "name", "description"]);
		scene = {
			id: identifier(s.id),
			place: {
				id: identifier(s.place.id),
				name: prose(s.place.name),
				description: prose(s.place.description),
			},
			description: prose(s.description),
			occupants: identifiers(s.occupants),
		};
	}
	const body = {
		version: 1 as const,
		worldId: identifier(value.worldId),
		authorAgentId: identifier(value.authorAgentId),
		source: parsePublicationEventSource(value.source),
		...parsePublicationMaterialFields(value),
		permittedScene: scene,
	};
	if (
		!body.audience.length ||
		body.source.eventId !== `${body.worldId}:${body.source.worldRevision}` ||
		!body.allowedClaims.some(
			(c) => c.kind === "world_event" && c.sourceId === body.source.eventId,
		)
	)
		throw Error("Invalid publication material source");
	const identified = { ...body, id: identifier(value.id) };
	if (
		identified.id !== `material-${lifeDigest(body)}` ||
		lifeDigest(identified) !== digest(value.digest)
	)
		throw Error("Corrupt publication material digest");
	return { ...identified, digest: value.digest as string };
}
export function publicationJobId(
	worldId: string,
	intentId: string,
	authorAgentId: string,
	recipientId: string,
): string {
	return `pubjob-${lifeDigest({ worldId, intentId, authorAgentId, recipientId })}`;
}
export function publicationAttemptId(jobId: string, attempt: number): string {
	return `pubattempt-${lifeDigest({ jobId, attempt })}`;
}
export function parsePublicationJob(value: unknown): PublicationJob {
	jsonBoundary(value);
	const selected =
		value !== null &&
		typeof value === "object" &&
		Object.hasOwn(value, "modelSelection");
	const reply = !!(
		value &&
		typeof value === "object" &&
		"version" in value &&
		value.version === 2
	);
	fields(value, [
		"version",
		"id",
		"worldId",
		"revision",
		reply ? "source" : "intentId",
		"authorAgentId",
		"recipientId",
		"attempt",
		"attemptId",
		"status",
		"material",
		"author",
		"modelSettingsRevision",
		...(selected ? (["modelSelection"] as const) : []),
		"decision",
		"postId",
		"error",
	]);
	if (value.version !== 1 && value.version !== 2)
		throw Error("Unsupported publication job version");
	const material =
			value.material === null ? null : parsePublicationMaterial(value.material),
		author =
			value.author === null ? null : parsePublicationAuthor(value.author);
	const common = {
		id: identifier(value.id),
		worldId: identifier(value.worldId),
		revision: revision(value.revision, 1),
		authorAgentId: identifier(value.authorAgentId),
		recipientId: identifier(value.recipientId),
		attempt: revision(value.attempt, 1),
		attemptId: identifier(value.attemptId),
		status: enumeration(value.status, [
			"pending",
			"prepared",
			"ready",
			"published",
			"skipped",
			"withheld",
			"failed",
			"unknown",
		]),
		author,
		modelSettingsRevision:
			value.modelSettingsRevision === null
				? null
				: revision(value.modelSettingsRevision),
		decision:
			value.decision === null
				? null
				: parsePublicationDecision(
						value.decision,
						material?.allowedClaims.map((c) => c.id) ?? [],
						reply ? "reply" : "event",
					),
		postId: nullableId(value.postId),
		error: value.error === null ? null : identifier(value.error),
	};
	let result: PublicationJob;
	if (value.version === 2) {
		fields(value.source, ["kind", "parentPostId"]);
		if (material && material.version !== 2)
			throw Error("Publication job material version mismatch");
		result = {
			...common,
			version: 2,
			source: {
				kind: enumeration(value.source.kind, ["reply"]),
				parentPostId: identifier(value.source.parentPostId),
			},
			material,
		};
	} else {
		if (material && material.version !== 1)
			throw Error("Publication job material version mismatch");
		result = {
			version: 1,
			id: common.id,
			worldId: common.worldId,
			revision: common.revision,
			intentId: identifier(value.intentId),
			authorAgentId: common.authorAgentId,
			recipientId: common.recipientId,
			attempt: common.attempt,
			attemptId: common.attemptId,
			status: common.status,
			material,
			author,
			modelSettingsRevision: common.modelSettingsRevision,
			decision: common.decision,
			postId: common.postId,
			error: common.error,
		};
	}
	if (selected) {
		const selection = parseLifeModelSelection(value.modelSelection);
		if (
			!material ||
			!author ||
			selection.settingsRevision !== result.modelSettingsRevision
		)
			throw Error("Incomplete publication model selection");
		result.modelSelection = selection;
	}
	const expectedId =
		result.version === 2
			? publicationReplyJobId(
					result.worldId,
					result.source.parentPostId,
					result.authorAgentId,
					result.recipientId,
				)
			: publicationJobId(
					result.worldId,
					result.intentId,
					result.authorAgentId,
					result.recipientId,
				);

	if (
		result.id !== expectedId ||
		result.attemptId !== publicationAttemptId(result.id, result.attempt)
	)
		throw Error("Corrupt publication job identity");

	if (
		(result.version === 1 &&
			result.material &&
			result.material.source.intentId !== result.intentId) ||
		(result.version === 2 &&
			result.material &&
			result.material.source.parentPostId !== result.source.parentPostId)
	)
		throw Error("Publication job material ownership mismatch");
	if (
		result.version === 2 &&
		result.postId !== null &&
		result.postId !==
			`pubpost-${lifeDigest({ worldId: result.worldId, jobId: result.id })}`
	)
		throw Error("Publication reply post identity mismatch");
	if (
		material &&
		(material.worldId !== result.worldId ||
			material.authorAgentId !== result.authorAgentId ||
			lifeDigest(material.audience) !== lifeDigest([result.recipientId]))
	)
		throw Error("Publication job material ownership mismatch");
	if (
		(material === null) !== (author === null) ||
		(material === null) !== (result.modelSettingsRevision === null) ||
		(author && author.agentId !== result.authorAgentId)
	)
		throw Error("Incomplete publication job source");
	if (
		result.status === "pending" &&
		(material || result.decision || result.postId || result.error)
	)
		throw Error("Unexpected pending publication outcome");
	if (
		["prepared", "unknown", "ready", "published", "skipped"].includes(
			result.status,
		) &&
		!material
	)
		throw Error("Missing frozen publication material");
	if (
		["ready", "published", "skipped"].includes(result.status) !==
		(result.decision !== null)
	)
		throw Error("Invalid publication decision state");
	if (
		(result.status === "published") !== (result.postId !== null) ||
		(result.status === "published" && result.decision?.kind !== "post") ||
		(result.status === "skipped" &&
			result.decision?.kind !== (reply ? "no_reply" : "no_post"))
	)
		throw Error("Invalid publication terminal outcome");
	if (
		["withheld", "failed", "unknown"].includes(result.status) !==
		(result.error !== null)
	)
		throw Error("Invalid publication failure state");
	return result;
}
