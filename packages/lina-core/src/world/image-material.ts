import type { PublishedImageMaterial } from "./image-types.ts";
import { lifeDigest } from "./life-json.ts";
import type { EventPublicationPost } from "./publication-types.ts";

/** Caller has resolved current whole-post authority. Imaginative segments are never scene evidence. */
export function publishedImageMaterial(
	post: EventPublicationPost,
	recipientId: string,
): PublishedImageMaterial | null {
	const claims = post.segments.flatMap((segment) =>
		segment.kind === "claim"
			? [{ kind: segment.claimKind, text: segment.text }]
			: [],
	);
	for (const claim of claims) {
		if (
			!post.material.allowedClaims.some(
				(allowed) => allowed.kind === claim.kind && allowed.text === claim.text,
			)
		)
			throw Error("Image claim differs from supported publication material");
	}
	const scene = structuredClone(post.material.permittedScene);
	if (!claims.length && !scene) return null;
	const material = {
		version: 1 as const,
		worldId: post.worldId,
		authorAgentId: post.author.agentId,
		source: {
			kind: "event_post" as const,
			publicationId: post.id,
			postRevision: post.revision,
			eventId: post.material.source.eventId,
			worldRevision: post.material.source.worldRevision,
			lifeRevision: post.material.source.lifeRevision,
			publicationMaterialId: post.material.id,
			publicationMaterialDigest: post.material.digest,
			recipientId,
		},
		claims,
		scene,
		fingerprint: lifeDigest({
			claims,
			scene: scene
				? {
						description: scene.description,
						occupants: [...scene.occupants].sort(),
						place: {
							name: scene.place.name,
							description: scene.place.description,
						},
					}
				: null,
		}),
	};
	return { ...material, digest: lifeDigest(material) };
}
