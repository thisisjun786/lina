import { lifeDigest } from "./life-json.ts";
import type {
	ClaimRef,
	DisclosurePolicy,
	KnowledgeGrant,
	LifeCommit,
	LifeDefinition,
	LifeState,
} from "./life-types.ts";
import type { WorldSnapshot } from "./types.ts";

function grantedAt(
	ref: ClaimRef,
	agentId: string,
	life: LifeState,
	at: number,
): boolean {
	return (
		life.version === 2 &&
		life.knowledgeGrants.some(
			(x) =>
				x.claim.kind === ref.kind &&
				x.claim.id === ref.id &&
				x.toAgentId === agentId &&
				life.baseWorldRevision + x.lifeRevision <= at,
		)
	);
}

/** A grant changes knowledge from its own event onward, never the original statement. */
export function knowsLifeClaimAt(
	id: string,
	agentId: string,
	life: LifeState,
	at = life.worldRevision,
): boolean {
	const claim = life.claims.find((x) => x.id === id);
	return (
		!!claim &&
		Number(claim.sourceEventId.split(":")[1]) <= at &&
		(claim.disclosure.knowers.includes(agentId) ||
			grantedAt({ kind: "life_claim", id }, agentId, life, at))
	);
}

export function knowsClaimAt(
	ref: ClaimRef,
	agentId: string,
	world: WorldSnapshot,
	life: LifeState,
	atWorldRevision = world.revision,
): boolean {
	if (
		!Number.isSafeInteger(atWorldRevision) ||
		atWorldRevision < 0 ||
		atWorldRevision > world.revision ||
		world.definition.id !== life.worldId ||
		life.worldRevision !== world.revision
	)
		return false;
	if (ref.kind === "life_claim")
		return knowsLifeClaimAt(ref.id, agentId, life, atWorldRevision);
	const fact = world.facts.find((x) => x.id === ref.id);
	return (
		!!fact &&
		(fact.sourceEventId === null ||
			Number(fact.sourceEventId.split(":")[1]) <= atWorldRevision) &&
		(fact.knownTo.includes(agentId) ||
			grantedAt(ref, agentId, life, atWorldRevision))
	);
}

/** The effective projection row is the sole disclosure authority. Creation metadata is not a fallback. */
export function currentDisclosurePolicy(
	ref: ClaimRef,
	definition: LifeDefinition,
): DisclosurePolicy | null {
	return (
		definition.projection.disclosures.find(
			(x) => x.subject.kind === ref.kind && x.subject.id === ref.id,
		)?.policy ?? null
	);
}

export function assertKnowledgeGrantAuthority(
	grant: KnowledgeGrant,
	definition: LifeDefinition,
): void {
	const policy = currentDisclosurePolicy(grant.claim, definition);
	if (
		!policy ||
		grant.definitionRevision !== definition.revision ||
		grant.projectionRevision !== definition.projection.revision ||
		grant.policyDigest !== lifeDigest(policy) ||
		!policy.knowers.includes(grant.fromAgentId) ||
		!policy.disclosures.some(
			(x) =>
				x.agentId === grant.fromAgentId && x.recipientId === grant.toAgentId,
		)
	)
		throw Error("LIFE disclosure policy conflict");
}

/** Validate new knowledge against the prior accepted boundary; same-event forwarding is impossible. */
export function assertKnowledgeGrantTransition(
	commit: LifeCommit,
	previous: LifeState,
	world: WorldSnapshot,
	definition: LifeDefinition,
): void {
	if (commit.version === 1) return;
	for (const grant of commit.knowledgeGrants) {
		if (!knowsClaimAt(grant.claim, grant.fromAgentId, world, previous))
			throw Error("LIFE grant sender lacks prior knowledge");
		if (knowsClaimAt(grant.claim, grant.toAgentId, world, previous))
			throw Error("Duplicate LIFE statement knowledge");
		assertKnowledgeGrantAuthority(grant, definition);
		if (
			grant.lifeRevision !== previous.revision + 1 ||
			grant.sourceEventId !== `${previous.worldId}:${world.revision + 1}` ||
			!commit.world.actorIds.includes(grant.fromAgentId) ||
			!commit.world.audience.includes(grant.toAgentId)
		)
			throw Error("LIFE grant event ownership mismatch");
		const experience = commit.experiences.find(
			(x) => x.id === grant.experienceId,
		);
		if (
			!experience ||
			experience.agentId !== grant.toAgentId ||
			experience.eventId !== grant.sourceEventId ||
			experience.channel === "inferred" ||
			!experience.claims.some(
				(x) => x.kind === grant.claim.kind && x.id === grant.claim.id,
			)
		)
			throw Error("LIFE grant recipient experience mismatch");
	}
}
