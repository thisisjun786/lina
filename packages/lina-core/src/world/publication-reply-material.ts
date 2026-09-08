import type { LifeConfig } from "./authoring-types.ts";
import { lifeDigest, revision } from "./life-json.ts";
import type {
	LifeDefinition,
	LifeState,
	LifeViewLimits,
} from "./life-types.ts";
import { parseLifeViewLimits } from "./life-validation.ts";
import type { PublicationChainRef } from "./publication-chains.ts";
import {
	type PublicationAuthority,
	parsePublicationAuthority,
	parsePublicationRoots,
} from "./publication-input.ts";
import { parseReplyPublicationMaterial } from "./publication-reply-records.ts";
import type {
	EventPublicationMaterial,
	PublicationSettings,
	PublicLifePost,
	ReplyPublicationMaterial,
} from "./publication-types.ts";
import type { WorldSnapshot } from "./types.ts";
import type { WorkEvidenceSnapshot } from "./work-types.ts";

/** Storage authenticates each binding against the actual published decision, not text equality alone. */
export interface PublicationReplyParent {
	owner: "post" | "reply";
	post: PublicLifePost;
	audience: string[];
	roots: PublicationChainRef[];
	origin: EventPublicationMaterial["source"];
	authority: PublicationAuthority;
	claims: Array<{
		segmentIndex: number;
		claim: EventPublicationMaterial["allowedClaims"][number];
	}>;
}
export interface PublicationReplyMaterialInput {
	world: WorldSnapshot;
	life: LifeState;
	definition: LifeDefinition;
	config: LifeConfig;
	settings: PublicationSettings;
	activeAgents: string[];
	agentId: string;
	recipientId: string;
	work: WorkEvidenceSnapshot;
	workAncestryRevision: number;
	limits: LifeViewLimits;
	parent: PublicationReplyParent;
}

export function selectPublicationReplyMaterial(
	input: PublicationReplyMaterialInput,
): ReplyPublicationMaterial | null {
	const { world, life, definition, config, settings, parent } = input;
	const worldId = world.definition.id;
	if (
		[
			life.worldId,
			definition.worldId,
			config.worldId,
			settings.worldId,
			input.work.worldId,
		].some((id) => id !== worldId) ||
		life.worldRevision !== world.revision ||
		life.definitionRevision !== definition.revision ||
		input.workAncestryRevision > life.revision
	)
		throw Error("Publication reply snapshot mismatch");
	if (
		!definition.participants.includes(input.agentId) ||
		!input.activeAgents.includes(input.agentId) ||
		!config.publication?.recipientIds.includes(input.recipientId) ||
		!parent.audience.includes(input.recipientId) ||
		!settings.agentRecipients.some(
			(mapping) =>
				mapping.agentId === input.agentId &&
				mapping.recipientId === input.recipientId,
		) ||
		(parent.post.author.kind === "agent" &&
			parent.post.author.agentId === input.agentId)
	)
		return null;
	const claims = new Map<
		string,
		EventPublicationMaterial["allowedClaims"][number]
	>();
	const bound = new Set<number>();
	for (const binding of parent.claims) {
		revision(binding.segmentIndex);
		const segment = parent.post.segments[binding.segmentIndex];
		if (
			bound.has(binding.segmentIndex) ||
			segment?.kind !== "claim" ||
			segment.claimKind !== binding.claim.kind ||
			segment.text !== binding.claim.text
		)
			throw Error(
				"Publication reply claim binding differs from visible parent",
			);
		bound.add(binding.segmentIndex);
		const prior = claims.get(binding.claim.id);
		if (prior && lifeDigest(prior) !== lifeDigest(binding.claim))
			throw Error("Conflicting publication reply claim binding");
		claims.set(binding.claim.id, structuredClone(binding.claim));
	}
	if (
		parent.post.segments.some(
			(segment, index) => segment.kind === "claim" && !bound.has(index),
		)
	)
		throw Error("Missing supported parent claim binding");
	const allowedClaims = [...claims.values()];
	const limits = parseLifeViewLimits(input.limits);
	const visible = {
		claims: allowedClaims.map(({ id, kind, text }) => ({ id, kind, text })),
		parent: { author: parent.post.author, segments: parent.post.segments },
	};
	if (
		allowedClaims.length + parent.post.segments.length > limits.maxRecords ||
		JSON.stringify(visible).length > limits.maxChars
	)
		return null;
	const body: Omit<ReplyPublicationMaterial, "id" | "digest"> = {
		version: 2,
		worldId,
		authorAgentId: input.agentId,
		source: {
			kind: "reply",
			parentPostId: parent.post.id,
			parentPostRevision: parent.post.revision,
			parentOwner: parent.owner,
			worldRevision: world.revision,
			lifeRevision: life.revision,
			origin: structuredClone(parent.origin),
		},
		definitionRevision: definition.revision,
		policyRevision: definition.projection.revision,
		workRevision: input.work.revision,
		workAncestryRevision: input.workAncestryRevision,
		workEvidenceDigest: lifeDigest(input.work),
		configRevision: config.revision,
		settingsRevision: settings.revision,
		limits,
		audience: [input.recipientId],
		allowedClaims,
		permittedScene: null,
		parent: structuredClone(parent.post),
		authority: parsePublicationAuthority(parent.authority),
		parentRoots: parsePublicationRoots(parent.roots),
	};
	const identified = { ...body, id: `material-${lifeDigest(body)}` };
	return parseReplyPublicationMaterial({
		...identified,
		digest: lifeDigest(identified),
	});
}
