import { lifeDigest } from "./life-json.ts";
import type { LifePersistence } from "./life-persistence.ts";
import type { LifeDefinition } from "./life-types.ts";
import type { PublicationPosts } from "./publication-posts.ts";
import type { PublicationReplyPosts } from "./publication-reply-posts.ts";
import type { PublicationJob } from "./publication-types.ts";
import type { WorldEvent } from "./types.ts";

interface SourceAccess {
	life: Pick<LifePersistence, "effects" | "snapshotAt" | "commitAt">;
	definitions(worldId: string): LifeDefinition[];
	event(worldId: string, worldRevision: number): WorldEvent;
	posts: Pick<PublicationPosts, "get">;
	replies: Pick<PublicationReplyPosts, "get">;
}

/** Authenticate immutable sources even before material exists; current access is checked separately. */
export function auditPublicationJobSource(
	job: PublicationJob,
	access: SourceAccess,
): void {
	if (
		!access
			.definitions(job.worldId)
			.some((definition) => definition.participants.includes(job.authorAgentId))
	)
		throw Error("Unknown historical publication author");
	if (job.version === 2) {
		const post = access.posts.get(job.worldId, job.source.parentPostId);
		const reply = access.replies.get(job.worldId, job.source.parentPostId);
		if (!post && !reply) throw Error("Missing publication parent");
		if (post && reply) throw Error("Ambiguous publication parent owner");
		return;
	}
	const intent = access.life
		.effects(job.worldId)
		.find((effect) => effect.id === job.intentId);
	if (!intent) throw Error("Unknown publication intent");
	const life = access.life.snapshotAt(job.worldId, intent.lifeRevision);
	const event = access.event(job.worldId, life.worldRevision);
	const { envelope, receipt } = access.life.commitAt(
		job.worldId,
		intent.lifeRevision,
	);
	if (
		intent.worldId !== job.worldId ||
		intent.payload.kind !== "publication_candidate" ||
		life.worldId !== job.worldId ||
		life.revision !== intent.lifeRevision ||
		event.worldId !== job.worldId ||
		event.id !== intent.payload.eventId ||
		event.revision !== life.worldRevision ||
		envelope.version !== 1 ||
		receipt?.eventId !== event.id ||
		receipt.worldRevision !== life.worldRevision ||
		!envelope.commit.effects.some(
			(effect) => lifeDigest(effect) === lifeDigest(intent),
		)
	)
		throw Error("Publication intent differs from accepted event history");
}
