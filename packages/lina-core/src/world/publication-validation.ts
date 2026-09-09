import {
	array,
	enumeration,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	MAX_LIFE_ITEMS,
	revision,
} from "./life-json.ts";
import type {
	PublicationDecision,
	PublicationEventRule,
	PublicationSegment,
	PublicationSettingsInput,
	PublicationSettingsV1,
} from "./publication-types.ts";
import { fields, integer, text } from "./validation.ts";

function count(value: unknown): number {
	integer(value, "publication capacity", 0, MAX_LIFE_ITEMS);
	return value;
}
export function parsePublicationSettings(
	value: unknown,
): PublicationSettingsInput {
	jsonBoundary(value);
	const version =
		value && typeof value === "object" && "version" in value
			? value.version
			: undefined;
	if (version !== 1 && version !== 2)
		throw Error("Unsupported publication settings version");
	fields(value, [
		"version",
		"agentRecipients",
		"reactionIds",
		"maxChainDepth",
		"maxActionsPerChain",
		"perAuthorCooldownSteps",
		"maxJobsPerRun",
		...(version === 2 ? ["worldVersion", "eventRules"] : []),
	]);
	const legacy: PublicationSettingsV1 = {
		version: 1,
		agentRecipients: keyed(
			array(value["agentRecipients"], (row) => {
				fields(row, ["agentId", "recipientId"]);
				return {
					agentId: identifier(row.agentId),
					recipientId: identifier(row.recipientId),
				};
			}),
			(row) => row.agentId,
		),
		reactionIds: identifiers(value["reactionIds"]),
		maxChainDepth: count(value["maxChainDepth"]),
		maxActionsPerChain: count(value["maxActionsPerChain"]),
		perAuthorCooldownSteps: revision(value["perAuthorCooldownSteps"]),
		maxJobsPerRun: count(value["maxJobsPerRun"]),
	};
	if (version === 1) return legacy;
	return {
		...legacy,
		version: 2,
		worldVersion: revision(value["worldVersion"], 1),
		eventRules: keyed(
			array(value["eventRules"], (row): PublicationEventRule => {
				fields(row, ["familyId", "authorAgentIds", "recipientIds", "summary"]);
				text(row.summary, "public event summary");
				return {
					familyId: identifier(row.familyId),
					authorAgentIds: identifiers(row.authorAgentIds),
					recipientIds: identifiers(row.recipientIds),
					summary: row.summary,
				};
			}),
			(row) => row.familyId,
		),
	};
}

export function parsePublicationDecision(
	value: unknown,
	allowedClaimIds: readonly string[],
	source: "event" | "reply",
): PublicationDecision {
	jsonBoundary(value);
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind !== "post"
	) {
		fields(value, ["kind"]);
		return {
			kind: enumeration(value.kind, [
				source === "event" ? "no_post" : "no_reply",
			]),
		};
	}
	fields(value, ["kind", "segments"]);
	enumeration(value.kind, ["post"]);
	const claims = new Set<string>();
	const segments = array(value.segments, (row): PublicationSegment => {
		if (
			row &&
			typeof row === "object" &&
			"kind" in row &&
			row.kind === "claim"
		) {
			fields(row, ["kind", "claimId"]);
			const claimId = identifier(row.claimId);
			if (!allowedClaimIds.includes(claimId) || claims.has(claimId))
				throw Error("Unsupported or duplicate publication claim");
			claims.add(claimId);
			return { kind: "claim", claimId };
		}
		fields(row, ["kind", "text"]);
		enumeration(row.kind, ["imaginative"]);
		text(row.text, "publication imaginative text");
		return { kind: "imaginative", text: row.text };
	});
	if (!segments.length) throw Error("Empty publication post");
	return { kind: "post", segments };
}
