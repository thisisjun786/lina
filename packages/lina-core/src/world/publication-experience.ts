import type { AutonomySource, LifeStep } from "./autonomy-types.ts";
import { lifeDigest } from "./life-json.ts";
import type { LifeCommitV3 } from "./life-types.ts";
import {
	type PublicationInputSource,
	parsePublicationEvidence,
	publicationGeneratedReplyText,
} from "./publication-input.ts";

function experienceText(source: PublicationInputSource): string {
	const who = source.principal.kind === "viewer" ? "A reader" : "An agent";
	switch (source.action.kind) {
		case "generated_reply":
			return publicationGeneratedReplyText(source.action.segments);
		case "reply":
			// Attribution is carried by the told/unknown experience and trusted input;
			// a textual prefix would overflow an otherwise valid maximum-length reply.
			return source.action.text;
		case "reaction":
			return `${who} ${source.action.active ? "added" : "removed"} the ${source.action.reactionId} reaction on a LIFE post.`;
		case "reshare":
			return `${who} reshared a LIFE post.`;
	}
}

/** Only the frozen permitted observation can become a private, uncertain experience. */
export function publicationExperiences(step: LifeStep) {
	if (step.version !== 3) return [];
	const blocked = new Set(step.source.publicationBudget?.blockedInputIds ?? []);
	return pendingPublicationExperiences(step.source).filter(
		(row) => !blocked.has(row.inputId),
	);
}

/** Eligibility before quantitative admission; the budget owner uses the same observation boundary. */
export function pendingPublicationExperiences(source: AutonomySource) {
	if (!source.publication)
		throw Error("Missing publication observation authority");
	const evidence = parsePublicationEvidence(source.publication);
	if (evidence.worldId !== source.pack.worldId)
		throw Error("Publication observation world mismatch");
	return evidence.records.flatMap((record) => {
		const input = source.inputs.find((input) => input.id === record.inputId);
		if (
			input?.version !== 3 ||
			input.worldId !== source.pack.worldId ||
			lifeDigest(input.source) !== lifeDigest(record.source) ||
			input.payloadDigest !== lifeDigest(record.source)
		)
			throw Error("Publication observation input mismatch");
		if (input.consumedLifeRevision !== null) return [];
		const agentId = record.source.recipientAgentId;
		if (
			!source.pack.roles.some(
				(role) => role.agentId === agentId && role.status === "active",
			)
		)
			return [];
		const scene = source.world.scenes.find((scene) =>
			scene.occupants.includes(agentId),
		);
		if (!scene) return [];
		const experienceId = `feedback-${lifeDigest([source.pack.worldId, input.id, agentId]).slice(0, 48)}`;
		if (
			source.life.experiences.some(
				(experience) => experience.id === experienceId,
			)
		)
			return [];
		return [
			{
				inputId: input.id,
				agentId,
				sceneId: scene.id,
				experienceId,
				text: experienceText(record.source),
			},
		];
	});
}

/** Does not write personality, relations, disclosure authority, or global truth. */
export function projectPublicationObservations(
	step: LifeStep,
	agentId: string,
) {
	const allowed = new Set(
		publicationExperiences(step)
			.filter((row) => row.agentId === agentId)
			.map((row) => row.inputId),
	);
	return (step.source.publication?.records ?? [])
		.filter((record) => allowed.has(record.inputId))
		.map(({ source }) => ({
			from:
				source.principal.kind === "agent"
					? { kind: "agent" as const, agentId: source.principal.agentId }
					: { kind: "viewer" as const },
			action: structuredClone(source.action),
		}));
}

/** Does not write personality, relations, disclosure authority, or global truth. */
export function applyPublicationExperiences(
	step: LifeStep,
	commit: LifeCommitV3,
): void {
	const observations = publicationExperiences(step);
	const first = observations[0];
	if (!first) return;
	if (commit.world.kind === "tick") {
		commit.world = {
			...commit.world,
			kind: "activity",
			sceneId: first.sceneId,
			actorIds: [first.agentId],
			summary: "LIFE feedback received",
			audience: [...new Set(observations.map((row) => row.agentId))].sort(),
		};
	}
	const eventId = `${step.worldId}:${step.source.world.revision + 1}`;
	for (const row of observations) {
		const claimId = `${row.experienceId}-claim`;
		commit.claims.push({
			id: claimId,
			text: row.text,
			sourceEventId: eventId,
			truth: "unknown",
			supersedes: null,
			disclosure: { knowers: [row.agentId], disclosures: [], publication: [] },
		});
		commit.experiences.push({
			id: row.experienceId,
			agentId: row.agentId,
			eventId,
			channel: "told",
			claims: [{ kind: "life_claim", id: claimId }],
			simulationTime: step.decision.simulationTime,
		});
		if (!commit.consumedInputIds.includes(row.inputId))
			commit.consumedInputIds.push(row.inputId);
	}
	commit.consumedInputIds.sort();
}
