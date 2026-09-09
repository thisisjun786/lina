import { identifier, lifeDigest } from "./life-json.ts";
import type { PublicationFeed } from "./publication-feed.ts";
import type { PublicationGrants } from "./publication-grants.ts";
import {
	type PublicationAuthority,
	parsePublicationAuthority,
} from "./publication-input.ts";
import type { PublicationInteractions } from "./publication-interactions.ts";
import type { PublicationJobs } from "./publication-jobs.ts";
import type { PublicationPosts } from "./publication-posts.ts";
import type { PublicationReplyParent } from "./publication-reply-material.ts";
import type { PublicationReplyPosts } from "./publication-reply-posts.ts";

interface Access {
	posts: Pick<PublicationPosts, "get" | "at">;
	replies: Pick<PublicationReplyPosts, "get" | "at">;
	jobs: Pick<PublicationJobs, "history">;
	interactions: Pick<PublicationInteractions, "get">;
	grants: Pick<PublicationGrants, "get" | "at">;
	feed: Pick<PublicationFeed, "content" | "parent">;
}

/** Authenticates the actual rendered decision and the complete mixed parent chain. */
export function publicationReplyParent(
	access: Access,
	worldId: string,
	parentId: string,
	agentId: string,
	recipientId: string,
	settingsRevision: number,
	saved?: PublicationAuthority,
): PublicationReplyParent | null {
	const principal = { kind: "agent" as const, agentId };
	const post = access.feed.content(worldId, principal, parentId);
	const parent = access.feed.parent(worldId, principal, parentId);
	if (!post || !parent || !parent.audience.includes(recipientId)) return null;
	const posts: PublicationAuthority["posts"] = [],
		grants = new Map<string, PublicationAuthority["grants"][number]>();
	const savedPosts = new Map(saved?.posts.map((ref) => [ref.id, ref])),
		savedGrants = new Map(saved?.grants.map((ref) => [ref.id, ref]));
	const seen = new Set<string>();
	let cursor = parentId,
		owner: "post" | "reply" | null = null;
	let claims: PublicationReplyParent["claims"] | null = null,
		origin: PublicationReplyParent["origin"] | null = null;
	while (true) {
		identifier(cursor);
		if (seen.has(cursor)) throw Error("Corrupt publication reply parent cycle");
		seen.add(cursor);
		const ref = savedPosts.get(cursor);
		if (saved && !ref)
			throw Error("Missing publication reply parent authority");
		const generated = saved
			? ref?.kind === "post"
				? access.posts.at(worldId, cursor, ref.revision)
				: null
			: access.posts.get(worldId, cursor);
		if (generated) {
			owner ??= "post";
			if (
				generated.withdrawn ||
				!generated.material.audience.includes(recipientId)
			)
				return null;
			posts.push({
				kind: "post",
				id: generated.id,
				revision: generated.revision,
			});
			const source =
				generated.material.version === 1
					? generated.material.source
					: generated.material.source.origin;
			if (origin && lifeDigest(origin) !== lifeDigest(source))
				throw Error("Publication reply origin differs from parent chain");
			origin = source;
			if (claims === null) {
				const job = access.jobs
					.history(worldId, generated.jobId)
					.find(
						(row) =>
							row.attemptId === generated.attemptId && row.status === "ready",
					);
				if (job?.decision?.kind !== "post" || !job.material)
					throw Error("Missing published parent decision");
				claims = job.decision.segments.flatMap((segment, segmentIndex) => {
					if (segment.kind !== "claim") return [];
					const claim = job.material?.allowedClaims.find(
						(row) => row.id === segment.claimId,
					);
					if (!claim) throw Error("Missing published parent claim binding");
					return [{ segmentIndex, claim }];
				});
			}
			if (generated.material.version === 1) break;
			cursor = generated.material.source.parentPostId;
			continue;
		}
		const reply = saved
			? ref?.kind === "reply"
				? access.replies.at(worldId, cursor, ref.revision)
				: null
			: access.replies.get(worldId, cursor);
		if (!reply) throw Error("Missing publication reply parent row");
		owner ??= "reply";
		if (reply.withdrawn || !reply.audience.includes(recipientId)) return null;
		posts.push({ kind: "reply", id: reply.id, revision: reply.revision });
		if (reply.principal.kind === "viewer") {
			const grantId = reply.principal.grantId,
				grantRef = savedGrants.get(grantId);
			if (saved && !grantRef)
				throw Error("Missing publication reply grant authority");
			const grant = saved
				? access.grants.at(worldId, grantId, grantRef?.revision ?? 0)
				: access.grants.get(worldId, grantId);
			if (
				grant.revoked ||
				grant.recipientId !== recipientId ||
				grant.settingsRevision > settingsRevision
			)
				return null;
			grants.set(grant.id, { id: grant.id, revision: grant.revision });
		}
		const interaction = access.interactions.get(worldId, reply.interactionId);
		if (interaction.action.kind === "reaction")
			throw Error("Reaction cannot own parent content");
		if (interaction.action.kind === "reply") claims ??= [];
		cursor = reply.parentPostId;
	}
	if (!owner || !origin || !claims)
		throw Error("Missing publication reply source");
	const authority = parsePublicationAuthority({
		settingsRevision,
		posts,
		grants: [...grants.values()],
	});
	if (saved && lifeDigest(authority) !== lifeDigest(saved))
		throw Error("Publication reply authority differs from ancestors");
	return {
		owner,
		post,
		audience: parent.audience,
		roots: parent.roots,
		origin,
		authority,
		claims,
	};
}
