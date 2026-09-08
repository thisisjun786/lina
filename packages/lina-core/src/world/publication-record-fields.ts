import {
	array,
	digest,
	enumeration,
	eventReference,
	finite,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import { parseLifeViewLimits } from "./life-validation.ts";
import type {
	EventPublicationMaterial,
	PublicationAuthor,
} from "./publication-types.ts";
import { fields, text } from "./validation.ts";

function prose(value: unknown): string {
	text(value, "publication text");
	return value;
}
export function parsePublicationAuthor(value: unknown): PublicationAuthor {
	jsonBoundary(value);
	fields(value, ["agentId", "name", "voice", "profileRevision", "behavior"]);
	fields(value.behavior, ["traits", "habits", "attitudes"]);
	return {
		agentId: identifier(value.agentId),
		name: prose(value.name),
		voice: prose(value.voice),
		profileRevision: revision(value.profileRevision, 1),
		behavior: {
			traits: array(value.behavior.traits, (v) => {
				fields(v, ["label", "value"]);
				return { label: prose(v.label), value: finite(v.value) };
			}),
			habits: array(value.behavior.habits, (v) => {
				fields(v, ["label", "value"]);
				return { label: prose(v.label), value: flag(v.value) };
			}),
			attitudes: array(value.behavior.attitudes, (v) => {
				fields(v, ["toAgentId", "label", "value"]);
				return {
					toAgentId: identifier(v.toAgentId),
					label: prose(v.label),
					value: finite(v.value),
				};
			}),
		},
	};
}

/** Shared fields only; version owners validate shape, source rules and the digest. */
export function parsePublicationMaterialFields(
	value: Record<
		| "definitionRevision"
		| "workRevision"
		| "workAncestryRevision"
		| "limits"
		| "policyRevision"
		| "configRevision"
		| "settingsRevision"
		| "workEvidenceDigest"
		| "audience"
		| "allowedClaims",
		unknown
	>,
) {
	return {
		definitionRevision: revision(value.definitionRevision, 1),
		workRevision: revision(value.workRevision),
		workAncestryRevision: revision(value.workAncestryRevision),
		limits: parseLifeViewLimits(value.limits),
		policyRevision: revision(value.policyRevision, 1),
		configRevision: revision(value.configRevision, 1),
		settingsRevision: revision(value.settingsRevision, 1),
		workEvidenceDigest: digest(value.workEvidenceDigest),
		audience: identifiers(value.audience),
		allowedClaims: keyed(
			array(value.allowedClaims, (c) => {
				fields(c, ["id", "kind", "sourceId", "text"]);
				const kind = enumeration(c.kind, [
						"world_event",
						"world_fact",
						"life_claim",
					]),
					sourceId =
						kind === "world_event"
							? eventReference(c.sourceId)
							: identifier(c.sourceId),
					id = identifier(c.id);
				if (id !== `claim-${lifeDigest({ kind, id: sourceId })}`)
					throw Error("Corrupt publication claim identity");
				return { id, kind, sourceId, text: prose(c.text) };
			}),
			(c) => c.id,
			false,
		),
	};
}
export function parsePublicationEventSource(
	value: unknown,
): EventPublicationMaterial["source"] {
	jsonBoundary(value);
	fields(value, [
		"kind",
		"intentId",
		"eventId",
		"worldRevision",
		"lifeRevision",
	]);
	return {
		kind: enumeration(value.kind, ["event"]),
		intentId: identifier(value.intentId),
		eventId: eventReference(value.eventId),
		worldRevision: revision(value.worldRevision, 1),
		lifeRevision: revision(value.lifeRevision, 1),
	};
}
