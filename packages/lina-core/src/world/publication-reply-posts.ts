import type { DatabaseSync } from "node:sqlite";
import {
	array,
	canonicalLifeJson,
	digest,
	enumeration,
	flag,
	identifier,
	identifiers,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { PublicationChainRef } from "./publication-chains.ts";
import {
	parsePublicationAction,
	parsePublicationPrincipal,
	parsePublicationRoots,
} from "./publication-input.ts";
import type { PublicationInteraction } from "./publication-interactions.ts";
import type { PublicationPrincipal } from "./publication-types.ts";
import { fields } from "./validation.ts";

export interface PublicationReplyPost {
	version: 1;
	worldId: string;
	id: string;
	revision: number;
	interactionId: string;
	parentPostId: string;
	principal: PublicationPrincipal;
	audience: string[];
	roots: PublicationChainRef[];
	createdAt: number;
	createdLifeRevision: number;
	withdrawn: boolean;
}
type Access = {
	interaction(worldId: string, id: string): PublicationInteraction;
};
type Source = { post: PublicationReplyPost; interactionDigest: string };
type Withdrawal = {
	worldId: string;
	postId: string;
	requestKey: string;
	expectedRevision: number;
};
const POST_COLUMNS = "world_id,post_id,revision,post_json,digest";
const REQUEST_COLUMNS =
	"world_id,post_id,request_key,expected_revision,result_revision,payload_digest";
const POST_IDENTITIES = `
 SELECT world_id,post_id FROM life_publication_reply_posts
 UNION SELECT world_id,post_id FROM life_publication_reply_post_history
 UNION SELECT world_id,post_id FROM life_publication_reply_post_receipts
 UNION SELECT world_id,post_id FROM life_publication_reply_post_requests
`;

/** Registered by the main schema owner within its migration transaction. */
export const PUBLICATION_REPLY_POSTS_SCHEMA: string = `
CREATE TABLE life_publication_reply_post_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision IN (1,2)),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_reply_posts (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision IN (1,2)),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL,
 PRIMARY KEY(world_id,post_id),
 FOREIGN KEY(world_id,post_id,revision) REFERENCES life_publication_reply_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_reply_post_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), interaction_id TEXT NOT NULL, post_id TEXT NOT NULL,
 interaction_digest TEXT NOT NULL, post_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,interaction_id), UNIQUE(world_id,post_id),
 FOREIGN KEY(world_id,post_id) REFERENCES life_publication_reply_posts(world_id,post_id)
) STRICT;
CREATE TABLE life_publication_reply_post_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, post_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision IN (1,2)),
 result_revision INTEGER NOT NULL CHECK(result_revision=2), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key),
 FOREIGN KEY(world_id,post_id,result_revision) REFERENCES life_publication_reply_post_history(world_id,post_id,revision)
) STRICT;
`;

function parsePost(value: unknown): PublicationReplyPost {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"revision",
		"interactionId",
		"parentPostId",
		"principal",
		"audience",
		"roots",
		"createdAt",
		"createdLifeRevision",
		"withdrawn",
	]);
	if (value.version !== 1)
		throw Error("Unsupported publication reply post version");
	const post: PublicationReplyPost = {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		interactionId: identifier(value.interactionId),
		parentPostId: identifier(value.parentPostId),
		principal: parsePublicationPrincipal(value.principal),
		audience: identifiers(value.audience),
		roots: parsePublicationRoots(value.roots),
		createdAt: revision(value.createdAt),
		createdLifeRevision: revision(value.createdLifeRevision),
		withdrawn: flag(value.withdrawn),
	};
	if (
		!post.audience.length ||
		!post.roots.length ||
		post.revision !== (post.withdrawn ? 2 : 1)
	)
		throw Error("Invalid publication reply post audience, roots or revision");
	return post;
}
/** Parse the supplied immutable source without performing an interaction-owner read. */
function fromInteraction(value: unknown): Source {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"id",
		"requestKey",
		"principal",
		"parentPostId",
		"expectedPostRevision",
		"action",
		"roots",
		"audience",
		"createdAt",
		"lifeRevision",
		"settingsRevision",
		"postId",
		"processing",
		"observationIds",
	]);
	if (value.version !== 1)
		throw Error("Unsupported publication interaction version");
	const source: PublicationInteraction = {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		requestKey: identifier(value.requestKey),
		principal: parsePublicationPrincipal(value.principal),
		parentPostId: identifier(value.parentPostId),
		expectedPostRevision: revision(value.expectedPostRevision, 1),
		action: parsePublicationAction(value.action),
		roots: parsePublicationRoots(value.roots),
		audience: identifiers(value.audience),
		createdAt: revision(value.createdAt),
		lifeRevision: revision(value.lifeRevision),
		settingsRevision: revision(value.settingsRevision, 1),
		postId: identifier(value.postId),
		processing: enumeration(value.processing, ["queued", "stopped"]),
		observationIds: keyed(
			array(value.observationIds, identifier),
			(id) => id,
			false,
		),
	};
	if (
		source.action.kind === "reaction" ||
		(source.processing === "stopped" && source.observationIds.length)
	)
		throw Error(
			"Publication reply post requires a reply or reshare interaction",
		);
	return {
		post: parsePost({
			version: 1,
			worldId: source.worldId,
			id: source.postId,
			revision: 1,
			interactionId: source.id,
			parentPostId: source.parentPostId,
			principal: source.principal,
			audience: source.audience,
			roots: source.roots,
			createdAt: source.createdAt,
			createdLifeRevision: source.lifeRevision,
			withdrawn: false,
		}),
		interactionDigest: lifeDigest(source),
	};
}
function decode(row: Record<string, unknown>): PublicationReplyPost {
	if (typeof row["post_json"] !== "string")
		throw Error("Invalid publication reply post JSON");
	const post = parsePost(JSON.parse(row["post_json"]));
	if (
		post.worldId !== row["world_id"] ||
		post.id !== row["post_id"] ||
		post.revision !== row["revision"] ||
		canonicalLifeJson(post) !== row["post_json"] ||
		lifeDigest(post) !== digest(row["digest"])
	)
		throw Error("Corrupt publication reply post row");
	return post;
}
function decodeWithdrawal(row: Record<string, unknown>): Withdrawal {
	const request: Withdrawal = {
		worldId: identifier(row["world_id"]),
		postId: identifier(row["post_id"]),
		requestKey: identifier(row["request_key"]),
		expectedRevision: revision(row["expected_revision"], 1),
	};
	if (
		![1, 2].includes(request.expectedRevision) ||
		row["result_revision"] !== 2 ||
		digest(row["payload_digest"]) !== lifeDigest(request)
	)
		throw Error("Corrupt publication reply withdrawal receipt");
	return request;
}

/**
 * Metadata/tombstone SQL owner. Caller holds BEGIN IMMEDIATE and rolls back errors.
 * Current viewer authority and reverse interaction-to-post completeness belong to main.
 * get/list/validate audit immutable history, so later revocation does not erase it.
 */
export class PublicationReplyPosts {
	constructor(
		private readonly db: DatabaseSync,
		private readonly access: Access,
	) {}

	create(interaction: PublicationInteraction): PublicationReplyPost {
		this.requireTransaction();
		const source = fromInteraction(interaction),
			post = source.post;
		// Even exact creation replay must avoid access.interaction: its outbox may be incomplete.
		const prior = this.read(post.worldId, post.id, source);
		if (prior) return prior;
		this.save(post);
		this.db
			.prepare(`INSERT INTO life_publication_reply_post_receipts
			(world_id,interaction_id,post_id,interaction_digest,post_digest) VALUES(?,?,?,?,?)`)
			.run(
				post.worldId,
				post.interactionId,
				post.id,
				source.interactionDigest,
				lifeDigest(post),
			);
		return post;
	}
	get(worldId: string, id: string): PublicationReplyPost | null {
		return this.read(identifier(worldId), identifier(id));
	}
	/** Internal historical source; does not grant present feed access. */
	at(worldId: string, id: string, atRevision: number): PublicationReplyPost {
		revision(atRevision, 1);
		if (!this.get(worldId, id)) throw Error("Unknown publication reply post");
		const row = this.db
			.prepare(
				`SELECT ${POST_COLUMNS} FROM life_publication_reply_post_history WHERE world_id=? AND post_id=? AND revision=?`,
			)
			.get(worldId, id, atRevision);
		if (!row) throw Error("Unknown publication reply post revision");
		return decode(row);
	}
	list(worldId: string): PublicationReplyPost[] {
		return this.db
			.prepare(
				`SELECT post_id FROM (${POST_IDENTITIES}) WHERE world_id=? ORDER BY post_id`,
			)
			.all(identifier(worldId))
			.map((row) => {
				const post = this.get(worldId, identifier(row["post_id"]));
				if (!post) throw Error("Missing publication reply post head");
				return post;
			});
	}
	withdraw(
		worldId: string,
		id: string,
		input: { requestKey: string; expectedRevision: number },
	): PublicationReplyPost {
		this.requireTransaction();
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedRevision"]);
		const request: Withdrawal = {
			worldId: identifier(worldId),
			postId: identifier(id),
			requestKey: identifier(input.requestKey),
			expectedRevision: revision(input.expectedRevision, 1),
		};
		const post = this.get(request.worldId, request.postId);
		if (!post) throw Error("Unknown publication reply post");
		const receipt = this.db
			.prepare(
				`SELECT ${REQUEST_COLUMNS} FROM life_publication_reply_post_requests WHERE world_id=? AND request_key=?`,
			)
			.get(request.worldId, request.requestKey);
		if (receipt) {
			if (lifeDigest(decodeWithdrawal(receipt)) !== lifeDigest(request))
				throw Error("Publication reply withdrawal conflict");
			return post;
		}
		if (post.revision !== request.expectedRevision)
			throw Error("Publication reply post revision conflict");
		const next = post.withdrawn
			? post
			: { ...post, revision: 2, withdrawn: true };
		if (!post.withdrawn) this.save(next);
		this.db
			.prepare(`INSERT INTO life_publication_reply_post_requests
			(world_id,request_key,post_id,expected_revision,result_revision,payload_digest) VALUES(?,?,?,?,?,?)`)
			.run(
				request.worldId,
				request.requestKey,
				request.postId,
				request.expectedRevision,
				next.revision,
				lifeDigest(request),
			);
		return next;
	}
	validate(): void {
		for (const row of this.db.prepare(POST_IDENTITIES).iterate()) {
			if (!this.get(identifier(row["world_id"]), identifier(row["post_id"])))
				throw Error("Missing publication reply post head");
		}
	}

	private requireTransaction(): void {
		if (!this.db.isTransaction)
			throw Error(
				"Publication reply post mutation requires caller transaction",
			);
	}
	private read(
		worldId: string,
		id: string,
		supplied?: Source,
	): PublicationReplyPost | null {
		const row = this.db
			.prepare(
				`SELECT ${POST_COLUMNS} FROM life_publication_reply_posts WHERE world_id=? AND post_id=?`,
			)
			.get(worldId, id);
		const history = this.db
			.prepare(
				`SELECT ${POST_COLUMNS} FROM life_publication_reply_post_history WHERE world_id=? AND post_id=? ORDER BY revision`,
			)
			.all(worldId, id)
			.map(decode);
		const receipt = this.db
			.prepare(`SELECT world_id,post_id,interaction_id,interaction_digest,post_digest
			FROM life_publication_reply_post_receipts WHERE world_id=? AND post_id=?`)
			.get(worldId, id);
		const requests = this.db
			.prepare(
				`SELECT ${REQUEST_COLUMNS} FROM life_publication_reply_post_requests WHERE world_id=? AND post_id=?`,
			)
			.all(worldId, id)
			.map(decodeWithdrawal);
		if (!row) {
			if (history.length || receipt || requests.length)
				throw Error("Missing publication reply post head");
			return null;
		}
		if (!this.db.prepare("SELECT id FROM worlds WHERE id=?").get(worldId))
			throw Error("Unknown publication reply post world");
		const head = decode(row),
			first = history[0];
		if (
			first?.revision !== 1 ||
			first.withdrawn ||
			history.length !== head.revision ||
			history.some(
				(post, index) =>
					post.revision !== index + 1 ||
					lifeDigest({ ...post, revision: 1, withdrawn: false }) !==
						lifeDigest(first),
			) ||
			lifeDigest(history.at(-1)) !== lifeDigest(head)
		)
			throw Error("Missing or regressed publication reply post history");
		const source =
			supplied ??
			fromInteraction(this.access.interaction(worldId, head.interactionId));
		if (
			!receipt ||
			identifier(receipt["interaction_id"]) !== head.interactionId ||
			digest(receipt["post_digest"]) !== lifeDigest(first) ||
			digest(receipt["interaction_digest"]) !== source.interactionDigest ||
			lifeDigest(source.post) !== lifeDigest(first)
		)
			throw Error(
				"Publication reply post original interaction or receipt mismatch",
			);
		this.checkWithdrawals(head, requests);
		return head;
	}
	private checkWithdrawals(
		post: PublicationReplyPost,
		requests: Withdrawal[],
	): void {
		let transitions = 0;
		for (const request of requests) {
			if (
				request.worldId !== post.worldId ||
				request.postId !== post.id ||
				!post.withdrawn
			)
				throw Error("Publication reply withdrawal receipt without tombstone");
			if (request.expectedRevision === 1) transitions++;
		}
		if (transitions !== (post.withdrawn ? 1 : 0))
			throw Error("Missing or duplicate publication reply withdrawal receipt");
	}
	private save(post: PublicationReplyPost): void {
		const json = canonicalLifeJson(post),
			hash = lifeDigest(post);
		this.db
			.prepare(
				`INSERT INTO life_publication_reply_post_history(world_id,post_id,revision,post_json,digest) VALUES(?,?,?,?,?)`,
			)
			.run(post.worldId, post.id, post.revision, json, hash);
		this.db
			.prepare(`INSERT INTO life_publication_reply_posts(world_id,post_id,revision,post_json,digest) VALUES(?,?,?,?,?)
			ON CONFLICT(world_id,post_id) DO UPDATE SET revision=excluded.revision,post_json=excluded.post_json,digest=excluded.digest`)
			.run(post.worldId, post.id, post.revision, json, hash);
	}
}
