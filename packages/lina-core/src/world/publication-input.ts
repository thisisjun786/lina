import {
	array,
	digest,
	enumeration,
	flag,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { PublicationChainRef } from "./publication-chains.ts";
import type {
	PublicationPrincipal,
	PublicationRenderedSegment,
} from "./publication-types.ts";
import { fields, text } from "./validation.ts";

export type PublicationUserInteractionAction =
	| { kind: "reply"; text: string }
	| { kind: "reaction"; reactionId: string; active: boolean }
	| { kind: "reshare" };
export type PublicationGeneratedReplyAction = {
	kind: "generated_reply";
	segments: PublicationRenderedSegment[];
};
export type PublicationInteractionAction =
	| PublicationUserInteractionAction
	| PublicationGeneratedReplyAction;

/** Shared admission/experience bound includes every provenance label and separator. */
export function publicationGeneratedReplyText(
	segments: PublicationRenderedSegment[],
): string {
	const rendered = segments
		.map((segment) =>
			segment.kind === "claim"
				? `[claim:${segment.claimKind}] ${segment.text}`
				: `[imaginative] ${segment.text}`,
		)
		.join("\n");
	text(rendered, "generated publication experience");
	return rendered;
}
export interface PublicationInputSource {
	kind: "publication_interaction";
	observationId: string;
	interactionId: string;
	postId: string;
	postRevision: number;
	principal: PublicationPrincipal;
	recipientAgentId: string;
	action: PublicationInteractionAction;
	roots: PublicationChainRef[];
}
export interface PublicationEvidenceSnapshot {
	version: 1;
	worldId: string;
	revision: number;
	permissionDigest: string;
	authority: PublicationAuthority;
	records: Array<{ inputId: string; source: PublicationInputSource }>;
}
export interface PublicationAuthority {
	settingsRevision: number;
	posts: Array<{ id: string; kind: "post" | "reply"; revision: number }>;
	grants: Array<{ id: string; revision: number }>;
}
export function parsePublicationAuthority(
	value: unknown,
): PublicationAuthority {
	jsonBoundary(value);
	fields(value, ["settingsRevision", "posts", "grants"]);
	return {
		settingsRevision: revision(value.settingsRevision),
		posts: keyed(
			array(value.posts, (row) => {
				fields(row, ["id", "kind", "revision"]);
				return {
					id: identifier(row.id),
					kind: enumeration(row.kind, ["post", "reply"]),
					revision: revision(row.revision, 1),
				};
			}),
			(row) => row.id,
		),
		grants: keyed(
			array(value.grants, (row) => {
				fields(row, ["id", "revision"]);
				return { id: identifier(row.id), revision: revision(row.revision, 1) };
			}),
			(row) => row.id,
		),
	};
}
export function publicationObservationId(
	worldId: string,
	interactionId: string,
	recipientAgentId: string,
): string {
	return `pubobs-${lifeDigest({ worldId: identifier(worldId), interactionId: identifier(interactionId), recipientAgentId: identifier(recipientAgentId) })}`;
}
export function parsePublicationPrincipal(
	value: unknown,
): PublicationPrincipal {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "viewer"
	) {
		fields(value, ["kind", "grantId"]);
		return { kind: "viewer", grantId: identifier(value.grantId) };
	}
	fields(value, ["kind", "agentId"]);
	return {
		kind: enumeration(value.kind, ["agent"]),
		agentId: identifier(value.agentId),
	};
}
export function parsePublicationAction(
	value: unknown,
): PublicationInteractionAction {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "generated_reply"
	) {
		fields(value, ["kind", "segments"]);
		const segments = array(
			value.segments,
			(segment): PublicationRenderedSegment => {
				if (
					segment &&
					typeof segment === "object" &&
					"kind" in segment &&
					segment.kind === "claim"
				) {
					fields(segment, ["kind", "claimKind", "text"]);
					text(segment.text, "generated publication claim");
					return {
						kind: "claim",
						claimKind: enumeration(segment.claimKind, [
							"world_event",
							"world_fact",
							"life_claim",
						]),
						text: segment.text,
					};
				}
				fields(segment, ["kind", "text"]);
				text(segment.text, "generated imaginative text");
				return {
					kind: enumeration(segment.kind, ["imaginative"]),
					text: segment.text,
				};
			},
		);
		publicationGeneratedReplyText(segments);
		return { kind: "generated_reply", segments };
	}
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "reply"
	) {
		fields(value, ["kind", "text"]);
		text(value.text, "publication reply");
		return { kind: "reply", text: value.text };
	}
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "reaction"
	) {
		fields(value, ["kind", "reactionId", "active"]);
		return {
			kind: "reaction",
			reactionId: identifier(value.reactionId),
			active: flag(value.active),
		};
	}
	fields(value, ["kind"]);
	return { kind: enumeration(value.kind, ["reshare"]) };
}
export function parsePublicationRoots(value: unknown): PublicationChainRef[] {
	return keyed(
		array(value, (r) => {
			fields(r, ["rootId", "depth"]);
			return { rootId: identifier(r.rootId), depth: revision(r.depth) };
		}),
		(r) => r.rootId,
	);
}
export function parsePublicationInputSource(
	value: unknown,
): PublicationInputSource {
	jsonBoundary(value);
	fields(value, [
		"kind",
		"observationId",
		"interactionId",
		"postId",
		"postRevision",
		"principal",
		"recipientAgentId",
		"action",
		"roots",
	]);
	const source: PublicationInputSource = {
		kind: enumeration(value.kind, ["publication_interaction"]),
		observationId: identifier(value.observationId),
		interactionId: identifier(value.interactionId),
		postId: identifier(value.postId),
		postRevision: revision(value.postRevision, 1),
		principal: parsePublicationPrincipal(value.principal),
		recipientAgentId: identifier(value.recipientAgentId),
		action: parsePublicationAction(value.action),
		roots: parsePublicationRoots(value.roots),
	};
	if (!source.roots.length)
		throw Error("Missing publication interaction roots");
	if (
		source.action.kind === "generated_reply" &&
		(source.principal.kind !== "agent" ||
			source.principal.agentId === source.recipientAgentId)
	)
		throw Error("Invalid generated publication observer or author");
	return source;
}
export function parsePublicationEvidence(
	value: unknown,
): PublicationEvidenceSnapshot {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"revision",
		"permissionDigest",
		"authority",
		"records",
	]);
	if (value.version !== 1)
		throw Error("Unsupported publication evidence version");
	const worldId = identifier(value.worldId);
	return {
		version: 1,
		worldId,
		revision: revision(value.revision),
		permissionDigest: digest(value.permissionDigest),
		authority: parsePublicationAuthority(value.authority),
		records: keyed(
			array(value.records, (r) => {
				fields(r, ["inputId", "source"]);
				const source = parsePublicationInputSource(r.source),
					inputId = identifier(r.inputId);
				if (
					inputId !== source.observationId ||
					inputId !==
						publicationObservationId(
							worldId,
							source.interactionId,
							source.recipientAgentId,
						)
				)
					throw Error("Publication observation identity mismatch");
				return { inputId, source };
			}),
			(r) => r.inputId,
		),
	};
}
