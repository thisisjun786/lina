import type { LifeStep } from "./autonomy-types.ts";
import { imageIntentId } from "./image-intents.ts";
import type {
	LifeImageIntent,
	LifeImageSettings,
	PublishedImageMaterial,
} from "./image-types.ts";
import type { EventPublicationPost } from "./publication-types.ts";

export type ImageDiscoveryStatus =
	| "not_configured"
	| "hold"
	| "ready"
	| "quiet"
	| "text_only"
	| "cooldown"
	| "unchanged";

export interface EventImageDiscoveryCandidate {
	kind: "event_post";
	status: "ready";
	agentId: string;
	source: PublishedImageMaterial["source"];
	publication: PublishedImageMaterial;
	visualAgentIds: string[];
	intentId: string;
	reason: "configured_published_material";
}

export interface EventImageDiscoverySkip {
	kind: "event_post";
	status: Exclude<ImageDiscoveryStatus, "not_configured" | "hold" | "ready">;
	postId: string;
	agentId: string;
	reason: string;
}

export interface EventImageDiscoveryInput {
	settings: LifeImageSettings | null;
	posts: Array<{
		post: EventPublicationPost;
		materials: Array<{ recipientId: string; material: PublishedImageMaterial }>;
	}>;
	acceptedSteps: LifeStep[];
	existingIntents: LifeImageIntent[];
}

function acceptedFamily(
	steps: LifeStep[],
	post: EventPublicationPost,
): { familyId: string; stepId: string } | null {
	const source = post.material.source;
	const step = steps.find(
		(candidate) =>
			candidate.status === "accepted" &&
			candidate.receipt !== null &&
			candidate.receipt.eventId === source.eventId &&
			candidate.receipt.worldRevision === source.worldRevision &&
			candidate.receipt.lifeRevision === source.lifeRevision &&
			candidate.decision.kind === "event" &&
			candidate.decision.agentId === post.author.agentId &&
			candidate.decision.familyId !== null,
	);
	return step?.decision.familyId
		? { familyId: step.decision.familyId, stepId: step.id }
		: null;
}

/**
 * Selects only already-published, currently permitted material. It deliberately
 * receives accepted steps rather than event prose, so family selection cannot be
 * inferred from text. The caller owns visual-identity freezing and all writes.
 */
export function discoverEventImageCandidates(input: EventImageDiscoveryInput): {
	status: ImageDiscoveryStatus;
	candidates: EventImageDiscoveryCandidate[];
	skips: EventImageDiscoverySkip[];
} {
	const settings = input.settings;
	if (!settings) return { status: "not_configured", candidates: [], skips: [] };
	if (!settings.eventRules.length)
		return { status: "hold", candidates: [], skips: [] };
	const candidates: EventImageDiscoveryCandidate[] = [];
	const skips: EventImageDiscoverySkip[] = [];
	for (const { post, materials } of input.posts) {
		const family = acceptedFamily(input.acceptedSteps, post);
		if (!family) {
			skips.push({
				kind: "event_post",
				status: "unchanged",
				postId: post.id,
				agentId: post.author.agentId,
				reason: "no_accepted_family_receipt",
			});
			continue;
		}
		const rule = settings.eventRules.find(
			(value) =>
				value.familyId === family.familyId &&
				value.agentIds.includes(post.author.agentId),
		);
		if (!rule) continue;
		const selected = [...materials].sort((a, b) =>
			a.recipientId.localeCompare(b.recipientId),
		)[0];
		if (!selected) {
			skips.push({
				kind: "event_post",
				status: "text_only",
				postId: post.id,
				agentId: post.author.agentId,
				reason: "no_currently_permitted_recipient",
			});
			continue;
		}
		for (const { material } of [selected]) {
			if (!material.claims.length && material.scene === null) {
				skips.push({
					kind: "event_post",
					status: "text_only",
					postId: post.id,
					agentId: post.author.agentId,
					reason: "no_permitted_image_material",
				});
				continue;
			}
			const intentId = imageIntentId({
				worldId: material.worldId,
				agentId: post.author.agentId,
				source: material.source,
				requestKey: null,
			});
			if (
				input.existingIntents.some((intent) => intent.intentId === intentId)
			) {
				skips.push({
					kind: "event_post",
					status: "unchanged",
					postId: post.id,
					agentId: post.author.agentId,
					reason: "original_post_intent_exists",
				});
				continue;
			}
			const recent = input.existingIntents.some(
				(intent) =>
					intent.owner.agentId === post.author.agentId &&
					intent.source.kind === "event_post" &&
					intent.createdLifeRevision + settings.perAuthorCooldownSteps >=
						material.source.lifeRevision,
			);
			const unchanged =
				rule.trigger === "scene_change" &&
				input.existingIntents.some(
					(intent) =>
						intent.owner.agentId === post.author.agentId &&
						intent.source.kind === "event_post" &&
						intent.material.publication?.fingerprint === material.fingerprint,
				);
			if (unchanged) {
				skips.push({
					kind: "event_post",
					status: "unchanged",
					postId: post.id,
					agentId: post.author.agentId,
					reason: "scene_fingerprint_unchanged",
				});
				continue;
			}
			if (recent) {
				skips.push({
					kind: "event_post",
					status: "cooldown",
					postId: post.id,
					agentId: post.author.agentId,
					reason: "per_author_cooldown_steps",
				});
				continue;
			}
			const visualAgentIds =
				rule.composition === "all_scene_subjects"
					? [...new Set(material.scene?.occupants ?? [])].sort()
					: [post.author.agentId];
			if (rule.composition === "all_scene_subjects" && !visualAgentIds.length) {
				skips.push({
					kind: "event_post",
					status: "text_only",
					postId: post.id,
					agentId: post.author.agentId,
					reason: "no_permitted_scene_occupants",
				});
				continue;
			}
			candidates.push({
				kind: "event_post",
				status: "ready",
				agentId: post.author.agentId,
				source: material.source,
				publication: material,
				visualAgentIds,
				intentId,
				reason: "configured_published_material",
			});
		}
	}
	return {
		status: candidates.length ? "ready" : (skips.at(-1)?.status ?? "quiet"),
		candidates,
		skips,
	};
}
