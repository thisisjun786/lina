import type { ProjectionPolicy } from "./life-types.ts";
import type { PublicationEventRule } from "./publication-types.ts";
import type { WorldEvent } from "./types.ts";

/** Family identity comes only from the store-verified accepted step and LIFE commit. */
export interface PublicationEventRules {
	familyId: string | null;
	rules: PublicationEventRule[];
}

/** Ephemeral disclosure and event copy; private text must never participate in public size limits. */
export function publicationEventForRecipient(
	event: WorldEvent,
	policy: ProjectionPolicy,
	source: PublicationEventRules | undefined,
	agentId: string,
	recipientId: string,
	workAllowed: boolean,
): { event: WorldEvent; policy: ProjectionPolicy } {
	const original = { event, policy };
	const explicit = policy.disclosures.find(
		(row) => row.subject.kind === "world_event" && row.subject.id === event.id,
	)?.policy;
	if (
		explicit?.knowers.includes(agentId) &&
		explicit.publication.includes(recipientId) &&
		explicit.disclosures.some(
			(row) => row.agentId === agentId && row.recipientId === recipientId,
		)
	)
		return original;
	if (!source?.familyId || !workAllowed || !event.audience.includes(agentId))
		return original;
	const rule = source.rules.find((row) => row.familyId === source.familyId);
	if (
		!rule ||
		!rule.authorAgentIds.includes(agentId) ||
		!rule.recipientIds.includes(recipientId)
	)
		return original;
	return {
		event: { ...event, summary: rule.summary },
		policy: {
			...policy,
			disclosures: [
				...policy.disclosures.filter(
					(row) =>
						row.subject.kind !== "world_event" || row.subject.id !== event.id,
				),
				{
					subject: { kind: "world_event", id: event.id },
					policy: {
						knowers: [agentId],
						disclosures: [{ agentId, recipientId }],
						publication: [recipientId],
					},
				},
			],
		},
	};
}
