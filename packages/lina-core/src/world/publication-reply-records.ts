import {
	array,
	digest,
	enumeration,
	flag,
	identifier,
	jsonBoundary,
	lifeDigest,
	revision,
} from "./life-json.ts";
import {
	parsePublicationAuthority,
	parsePublicationRoots,
} from "./publication-input.ts";
import {
	parsePublicationAuthor,
	parsePublicationEventSource,
	parsePublicationMaterialFields,
} from "./publication-record-fields.ts";
import type {
	PublicationRenderedSegment,
	PublicLifePost,
	ReplyMaterialSource,
	ReplyPublicationMaterial,
	ReplyPublicationPost,
} from "./publication-types.ts";
import { fields, text } from "./validation.ts";

export function publicationReplyJobId(
	worldId: string,
	parentPostId: string,
	authorAgentId: string,
	recipientId: string,
): string {
	return `pubjob-${lifeDigest({ worldId, source: { kind: "reply", parentPostId }, authorAgentId, recipientId })}`;
}

function renderedSegment(value: unknown): PublicationRenderedSegment {
	if (
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind === "claim"
	) {
		fields(value, ["kind", "claimKind", "text"]);
		text(value.text, "public claim");
		return {
			kind: "claim",
			claimKind: enumeration(value.claimKind, [
				"world_event",
				"world_fact",
				"life_claim",
			]),
			text: value.text,
		};
	}
	fields(value, ["kind", "text"]);
	text(value.text, "imaginative post");
	return { kind: enumeration(value.kind, ["imaginative"]), text: value.text };
}

function parentPost(value: unknown): PublicLifePost {
	const linked = !!(
		value &&
		typeof value === "object" &&
		"kind" in value &&
		value.kind !== "post"
	);
	fields(value, [
		"id",
		"revision",
		"kind",
		"author",
		"segments",
		"createdAt",
		...(linked ? (["parentPostId"] as const) : []),
	]);
	let author: PublicLifePost["author"];
	if (
		value.author &&
		typeof value.author === "object" &&
		"kind" in value.author &&
		value.author.kind === "agent"
	) {
		fields(value.author, ["kind", "agentId", "name"]);
		if (value.author.name !== null)
			text(value.author.name, "public author name");
		author = {
			kind: "agent",
			agentId: identifier(value.author.agentId),
			name: value.author.name,
		};
	} else {
		fields(value.author, ["kind"]);
		author = { kind: enumeration(value.author.kind, ["viewer"]) };
	}
	const post: PublicLifePost = {
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		kind: enumeration(value.kind, ["post", "reply", "reshare"]),
		author,
		...(linked ? { parentPostId: identifier(value.parentPostId) } : {}),
		segments: array(value.segments, (segment) => {
			if (
				segment &&
				typeof segment === "object" &&
				"kind" in segment &&
				segment.kind === "user_authored"
			) {
				fields(segment, ["kind", "text"]);
				text(segment.text, "user-authored post");
				return { kind: "user_authored", text: segment.text };
			}
			return renderedSegment(segment);
		}),
		createdAt: revision(value.createdAt),
	};
	if (!post.segments.length || post.parentPostId === post.id)
		throw Error("Invalid publication parent post");
	return post;
}

function replySource(value: unknown): ReplyMaterialSource {
	fields(value, [
		"kind",
		"parentPostId",
		"parentPostRevision",
		"parentOwner",
		"worldRevision",
		"lifeRevision",
		"origin",
	]);
	return {
		kind: enumeration(value.kind, ["reply"]),
		parentPostId: identifier(value.parentPostId),
		parentPostRevision: revision(value.parentPostRevision, 1),
		parentOwner: enumeration(value.parentOwner, ["post", "reply"]),
		worldRevision: revision(value.worldRevision, 1),
		lifeRevision: revision(value.lifeRevision, 1),
		origin: parsePublicationEventSource(value.origin),
	};
}

function validateParent(
	material: Omit<ReplyPublicationMaterial, "id" | "digest">,
): void {
	const { source, parent, authority, parentRoots } = material;
	const reference = authority.posts.find(
		(post) => post.id === source.parentPostId,
	);
	if (
		parent.id !== source.parentPostId ||
		parent.revision !== source.parentPostRevision ||
		!reference ||
		reference.kind !== source.parentOwner ||
		reference.revision !== parent.revision ||
		authority.settingsRevision !== material.settingsRevision ||
		(parent.author.kind === "agent" &&
			parent.author.agentId === material.authorAgentId) ||
		!parentRoots.length ||
		!material.audience.length ||
		source.origin.eventId !==
			`${material.worldId}:${source.origin.worldRevision}` ||
		source.worldRevision < source.origin.worldRevision ||
		source.lifeRevision < source.origin.lifeRevision
	)
		throw Error("Invalid publication reply parent authority or origin");
	if (
		source.parentOwner === "post"
			? parent.kind === "reshare" ||
				parent.author.kind !== "agent" ||
				parent.segments.some((s) => s.kind === "user_authored")
			: parent.kind === "post" ||
				(parent.kind === "reply" &&
					parent.segments.some((s) => s.kind !== "user_authored"))
	)
		throw Error("Invalid publication reply parent owner");
	if (
		parent.parentPostId &&
		!authority.posts.some((post) => post.id === parent.parentPostId)
	)
		throw Error("Missing publication parent ancestor reference");
	for (const recipient of material.audience) {
		const jobId = publicationReplyJobId(
			material.worldId,
			parent.id,
			material.authorAgentId,
			recipient,
		);
		const postId = `pubpost-${lifeDigest({ worldId: material.worldId, jobId })}`;
		if (authority.posts.some((post) => post.id === postId))
			throw Error("Cyclic publication reply authority");
	}
	if (
		material.allowedClaims.some(
			(claim) =>
				!parent.segments.some(
					(segment) =>
						segment.kind === "claim" &&
						segment.claimKind === claim.kind &&
						segment.text === claim.text,
				),
		)
	)
		throw Error("Publication reply claim is not supported by visible parent");
}

/** Pure internal-consistency codec. Storage must authenticate frozen snapshots,
 * ancestor revisions, grants and each claim sourceId against the actual ancestors.
 */
export function parseReplyPublicationMaterial(
	value: unknown,
): ReplyPublicationMaterial {
	jsonBoundary(value);
	fields(value, [
		"version",
		"id",
		"worldId",
		"authorAgentId",
		"source",
		"definitionRevision",
		"workRevision",
		"workAncestryRevision",
		"limits",
		"policyRevision",
		"configRevision",
		"settingsRevision",
		"workEvidenceDigest",
		"audience",
		"allowedClaims",
		"permittedScene",
		"digest",
		"parent",
		"authority",
		"parentRoots",
	]);
	if (value.version !== 2 || value.permittedScene !== null)
		throw Error("Invalid reply material version or scene");
	const body = {
		version: 2 as const,
		worldId: identifier(value.worldId),
		authorAgentId: identifier(value.authorAgentId),
		source: replySource(value.source),
		...parsePublicationMaterialFields(value),
		permittedScene: null,
		parent: parentPost(value.parent),
		authority: parsePublicationAuthority(value.authority),
		parentRoots: parsePublicationRoots(value.parentRoots),
	};
	validateParent(body);
	const identified = { ...body, id: identifier(value.id) };
	const hash = digest(value.digest);
	if (
		identified.id !== `material-${lifeDigest(body)}` ||
		lifeDigest(identified) !== hash
	)
		throw Error("Corrupt publication reply material digest");
	return { ...identified, digest: hash };
}

export function parseReplyPublicationPost(
	value: unknown,
): ReplyPublicationPost {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"revision",
		"jobId",
		"attemptId",
		"material",
		"author",
		"roots",
		"segments",
		"createdAt",
		"createdLifeRevision",
		"withdrawn",
	]);
	if (value.version !== 2)
		throw Error("Unsupported publication reply post version");
	const post: ReplyPublicationPost = {
		version: 2,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		jobId: identifier(value.jobId),
		attemptId: identifier(value.attemptId),
		material: parseReplyPublicationMaterial(value.material),
		author: parsePublicationAuthor(value.author),
		roots: parsePublicationRoots(value.roots),
		segments: array(value.segments, renderedSegment),
		createdAt: revision(value.createdAt),
		createdLifeRevision: revision(value.createdLifeRevision, 1),
		withdrawn: flag(value.withdrawn),
	};
	const { material } = post;
	const recipient = material.audience[0];
	if (
		!recipient ||
		material.audience.length !== 1 ||
		post.id !==
			`pubpost-${lifeDigest({ worldId: post.worldId, jobId: post.jobId })}` ||
		post.jobId !==
			publicationReplyJobId(
				post.worldId,
				material.source.parentPostId,
				post.author.agentId,
				recipient,
			) ||
		post.worldId !== material.worldId ||
		post.author.agentId !== material.authorAgentId ||
		!post.segments.length ||
		post.revision !== (post.withdrawn ? 2 : 1) ||
		post.createdLifeRevision < material.source.lifeRevision ||
		lifeDigest(post.roots) !==
			lifeDigest(
				material.parentRoots.map((root) => ({
					rootId: root.rootId,
					depth: revision(root.depth + 1),
				})),
			)
	)
		throw Error("Invalid publication reply post source or roots");
	if (
		post.segments.some(
			(segment) =>
				segment.kind === "claim" &&
				!material.allowedClaims.some(
					(claim) =>
						claim.kind === segment.claimKind && claim.text === segment.text,
				),
		)
	)
		throw Error("Publication reply post claim is not permitted");
	return post;
}
