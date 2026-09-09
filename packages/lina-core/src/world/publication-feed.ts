import {
	canonicalLifeJson,
	digest,
	identifier,
	jsonBoundary,
	lifeDigest,
} from "./life-json.ts";
import type { PublicationGrants } from "./publication-grants.ts";
import type { PublicationInteractions } from "./publication-interactions.ts";
import type { PublicationPosts } from "./publication-posts.ts";
import type {
	PublicationReplyPost,
	PublicationReplyPosts,
} from "./publication-reply-posts.ts";
import type {
	PublicationMaterial,
	PublicationPost,
	PublicationPrincipal,
	PublicLifeImage,
	PublicLifePost,
	PublicLifePostView,
	PublicLifeReactionState,
	ReplyPublicationPost,
} from "./publication-types.ts";
import { fields, integer, MAX_WORLD_BYTES } from "./validation.ts";

interface Authority {
	recipients(worldId: string): {
		revision: number;
		recipientIds: string[];
		agents: Array<{ agentId: string; recipientId: string }>;
	} | null;
	/** Checks this owner's material only; parent visibility is resolved iteratively. */
	material(material: PublicationMaterial): PublicationMaterial | null;
	/** Current principal's configured reactions, called only after visibility succeeds. */
	reactions?(
		worldId: string,
		principal: PublicationPrincipal,
		postId: string,
	): PublicLifeReactionState[];
}
/** Read-only application boundary. It has no simulation, job admission or model port. */
export class PublicationFeed {
	constructor(
		private readonly posts: Pick<PublicationPosts, "get" | "list">,
		private readonly grants: Pick<PublicationGrants, "get">,
		private readonly authority: Authority,
		private readonly replies: {
			posts: Pick<PublicationReplyPosts, "get" | "list">;
			interactions: Pick<PublicationInteractions, "get">;
		},
	) {}
	recipient(worldId: string, principal: PublicationPrincipal): string {
		identifier(worldId);
		jsonBoundary(principal);
		const current = this.authority.recipients(worldId);
		if (!current) throw Error("Publication principal forbidden");
		if (principal.kind === "viewer") {
			fields(principal, ["kind", "grantId"]);
			const grant = this.grants.get(worldId, identifier(principal.grantId));
			if (
				grant.revoked ||
				grant.settingsRevision > current.revision ||
				!current.recipientIds.includes(grant.recipientId)
			)
				throw Error("Publication principal forbidden");
			return grant.recipientId;
		}
		fields(principal, ["kind", "agentId"]);
		if (principal.kind !== "agent")
			throw Error("Publication principal forbidden");
		const mapping = current.agents.find(
			(a) => a.agentId === identifier(principal.agentId),
		);
		if (!mapping || !current.recipientIds.includes(mapping.recipientId))
			throw Error("Publication principal forbidden");
		return mapping.recipientId;
	}
	private allowed(post: PublicationPost, recipientId: string): boolean {
		if (post.withdrawn || !post.material.audience.includes(recipientId))
			return false;
		const current = this.authority.material(post.material);
		return (
			!!current &&
			post.material.allowedClaims.every((claim) =>
				current.allowedClaims.some(
					(other) => lifeDigest(claim) === lifeDigest(other),
				),
			) &&
			(post.material.permittedScene === null ||
				lifeDigest(post.material.permittedScene) ===
					lifeDigest(current.permittedScene))
		);
	}
	private publicPost(post: PublicationPost): PublicLifePost {
		return {
			id: post.id,
			revision: post.revision,
			kind: post.version === 2 ? "reply" : "post",
			...(post.version === 2
				? { parentPostId: post.material.source.parentPostId }
				: {}),
			author: {
				kind: "agent",
				agentId: post.author.agentId,
				name: post.author.name,
			},
			segments: structuredClone(post.segments),
			createdAt: post.createdAt,
		};
	}
	private resolve(
		worldId: string,
		postId: string,
		recipient: string,
	): {
		post: PublicLifePost;
		audience: string[];
		roots: PublicationPost["roots"];
	} | null {
		const seen = new Set<string>(),
			path: Array<PublicationReplyPost | ReplyPublicationPost> = [];
		let cursor = postId,
			original: PublicationPost | null = null;
		while (true) {
			identifier(cursor);
			if (seen.has(cursor)) throw Error("Corrupt publication parent cycle");
			seen.add(cursor);
			original = this.posts.get(worldId, cursor);
			if (original) {
				if (original.version === 1) break;
				if (
					original.withdrawn ||
					!original.material.audience.includes(recipient)
				)
					return null;
				path.push(original);
				cursor = original.material.source.parentPostId;
				continue;
			}
			const reply = this.replies.posts.get(worldId, cursor);
			if (!reply || reply.withdrawn || !reply.audience.includes(recipient))
				return null;
			path.push(reply);
			cursor = reply.parentPostId;
		}
		if (!this.allowed(original, recipient)) return null;
		let resolved = {
			post: this.publicPost(original),
			audience: original.material.audience,
			roots: original.roots,
		};
		for (const reply of path.reverse()) {
			if ("material" in reply) {
				if (!this.allowed(reply, recipient)) return null;
				resolved = {
					post: this.publicPost(reply),
					audience: reply.material.audience.filter((id) =>
						resolved.audience.includes(id),
					),
					roots: reply.roots,
				};
				continue;
			}
			const interaction = this.replies.interactions.get(
				worldId,
				reply.interactionId,
			);
			if (interaction.action.kind === "reaction")
				throw Error("Reaction cannot be a publication post");
			if (
				interaction.action.kind !== "reply" &&
				interaction.action.kind !== "reshare"
			)
				throw Error("Only replies and reshares can be user publication posts");
			resolved = {
				post: {
					id: reply.id,
					revision: reply.revision,
					kind: interaction.action.kind,
					parentPostId: reply.parentPostId,
					createdAt: reply.createdAt,
					author:
						reply.principal.kind === "viewer"
							? { kind: "viewer" }
							: { kind: "agent", agentId: reply.principal.agentId, name: null },
					segments:
						interaction.action.kind === "reply"
							? [{ kind: "user_authored", text: interaction.action.text }]
							: structuredClone(resolved.post.segments),
				},
				audience: reply.audience.filter((id) => resolved.audience.includes(id)),
				roots: reply.roots,
			};
		}
		return resolved;
	}
	/** Trusted interaction admission metadata; never serialized by the feed API. */
	parent(worldId: string, principal: PublicationPrincipal, postId: string) {
		const resolved = this.resolve(
			worldId,
			postId,
			this.recipient(worldId, principal),
		);
		return resolved
			? {
					id: resolved.post.id,
					revision: resolved.post.revision,
					audience: resolved.audience,
					roots: resolved.roots,
				}
			: null;
	}
	/** Immutable public content for frozen material and authority checks. */
	content(
		worldId: string,
		principal: PublicationPrincipal,
		postId: string,
	): PublicLifePost | null {
		return (
			this.resolve(worldId, postId, this.recipient(worldId, principal))?.post ??
			null
		);
	}
	post(
		worldId: string,
		principal: PublicationPrincipal,
		postId: string,
		images?: ReadonlyMap<string, PublicLifeImage>,
	): PublicLifePostView | null {
		const post = this.content(worldId, principal, postId);
		return post ? this.view(worldId, principal, post, images) : null;
	}
	private view(
		worldId: string,
		principal: PublicationPrincipal,
		post: PublicLifePost,
		images?: ReadonlyMap<string, PublicLifeImage>,
	): PublicLifePostView {
		const image = images?.get(post.id);
		return {
			...post,
			...(image ? { image: structuredClone(image) } : {}),
			reactions: (
				this.authority.reactions?.(worldId, principal, post.id) ?? []
			).map(({ reactionId, active }) => ({ reactionId, active })),
		};
	}
	query(
		worldId: string,
		principal: PublicationPrincipal,
		input: { limit: number; after: string | null },
		images?: ReadonlyMap<string, PublicLifeImage>,
	): { items: PublicLifePostView[]; nextCursor: string | null } {
		jsonBoundary(input);
		fields(input, ["limit", "after"]);
		integer(input.limit, "feed page size", 1, 100);
		const recipient = this.recipient(worldId, principal),
			visible = [
				...this.posts.list(worldId),
				...this.replies.posts.list(worldId),
			]
				.sort(
					(a, b) =>
						b.createdAt - a.createdAt ||
						b.createdLifeRevision - a.createdLifeRevision ||
						a.id.localeCompare(b.id),
				)
				.flatMap((post) => {
					const resolved = this.resolve(worldId, post.id, recipient);
					return resolved
						? [this.view(worldId, principal, resolved.post, images)]
						: [];
				});
		const scope = lifeDigest({
			worldId,
			principal,
			visible: visible.map((post) => ({
				id: post.id,
				revision: post.revision,
				reactions: lifeDigest(post.reactions),
				...(post.image ? { image: lifeDigest(post.image) } : {}),
			})),
		});
		let offset = 0;
		if (input.after !== null) {
			if (
				typeof input.after !== "string" ||
				input.after.length > 2048 ||
				!/^[A-Za-z0-9_-]+$/.test(input.after)
			)
				throw Error("Invalid publication cursor");
			const bytes = Buffer.from(input.after, "base64url");
			if (bytes.toString("base64url") !== input.after)
				throw Error("Invalid publication cursor");
			const cursor: unknown = JSON.parse(bytes.toString("utf8"));
			jsonBoundary(cursor);
			fields(cursor, ["version", "scope", "postId"]);
			if (cursor.version !== 1 || digest(cursor.scope) !== scope)
				throw Error("Publication cursor scope changed");
			const index = visible.findIndex(
				(post) => post.id === identifier(cursor.postId),
			);
			if (index < 0) throw Error("Publication cursor unavailable");
			offset = index + 1;
		}
		const items: PublicLifePostView[] = [];
		for (const post of visible.slice(offset, offset + input.limit)) {
			const item = post;
			if (
				Buffer.byteLength(canonicalLifeJson([...items, item])) >
				MAX_WORLD_BYTES - 4096
			) {
				if (!items.length)
					throw Error("Publication post exceeds feed capacity");
				break;
			}
			items.push(item);
		}
		const last = items.at(-1),
			more = offset + items.length < visible.length;
		return {
			items,
			nextCursor:
				more && last
					? Buffer.from(
							canonicalLifeJson({ version: 1, scope, postId: last.id }),
						).toString("base64url")
					: null,
		};
	}
}
