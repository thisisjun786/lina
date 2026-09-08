import type { DatabaseSync } from "node:sqlite";
import {
	array,
	canonicalLifeJson,
	digest,
	enumeration,
	flag,
	identifier,
	jsonBoundary,
	keyed,
	lifeDigest,
	revision,
} from "./life-json.ts";
import type { PublicationJobs } from "./publication-jobs.ts";
import {
	parsePublicationAuthor,
	parsePublicationMaterial,
} from "./publication-record-validation.ts";
import { parseReplyPublicationPost } from "./publication-reply-records.ts";
import type {
	EventPublicationPost,
	PublicationJob,
	PublicationPost,
	PublicationRenderedSegment,
} from "./publication-types.ts";
import { fields, text } from "./validation.ts";

export const PUBLICATION_POSTS_SCHEMA = `
CREATE TABLE life_publication_post_history (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_posts (
 world_id TEXT NOT NULL REFERENCES worlds(id), post_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 post_json TEXT NOT NULL CHECK(json_valid(post_json)), digest TEXT NOT NULL, PRIMARY KEY(world_id,post_id),
 FOREIGN KEY(world_id,post_id,revision) REFERENCES life_publication_post_history(world_id,post_id,revision)
) STRICT;
CREATE TABLE life_publication_post_receipts (
 world_id TEXT NOT NULL REFERENCES worlds(id), job_id TEXT NOT NULL, post_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,job_id), UNIQUE(world_id,post_id),
 FOREIGN KEY(world_id,job_id) REFERENCES life_publication_jobs(world_id,job_id), FOREIGN KEY(world_id,post_id) REFERENCES life_publication_posts(world_id,post_id)
) STRICT;
CREATE TABLE life_publication_post_requests (
 world_id TEXT NOT NULL REFERENCES worlds(id), request_key TEXT NOT NULL, post_id TEXT NOT NULL,
 expected_revision INTEGER NOT NULL CHECK(expected_revision>0), result_revision INTEGER NOT NULL CHECK(result_revision>0), payload_digest TEXT NOT NULL,
 PRIMARY KEY(world_id,request_key), FOREIGN KEY(world_id,post_id,result_revision) REFERENCES life_publication_post_history(world_id,post_id,revision)
) STRICT;
`;
function render(job: PublicationJob): PublicationRenderedSegment[] {
	if (job.decision?.kind !== "post" || !job.material)
		throw Error("Missing publication post decision");
	return job.decision.segments.map((segment) => {
		if (segment.kind === "imaginative") return { ...segment };
		const claim = job.material?.allowedClaims.find(
			(c) => c.id === segment.claimId,
		);
		if (!claim) throw Error("Missing permitted publication claim");
		return { kind: "claim", claimKind: claim.kind, text: claim.text };
	});
}
function parsePost(value: unknown): PublicationPost {
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
	if (value.version === 2) return parseReplyPublicationPost(value);
	if (value.version !== 1) throw Error("Unsupported publication post version");
	const material = parsePublicationMaterial(value.material);
	if (material.version !== 1)
		throw Error("Publication post material version mismatch");
	const post: EventPublicationPost = {
		version: 1,
		worldId: identifier(value.worldId),
		id: identifier(value.id),
		revision: revision(value.revision, 1),
		jobId: identifier(value.jobId),
		attemptId: identifier(value.attemptId),
		material,
		author: parsePublicationAuthor(value.author),
		roots: keyed(
			array(value.roots, (r) => {
				fields(r, ["rootId", "depth"]);
				return { rootId: identifier(r.rootId), depth: revision(r.depth) };
			}),
			(r) => r.rootId,
		),
		segments: array(value.segments, (s) => {
			if (s && typeof s === "object" && "kind" in s && s.kind === "claim") {
				fields(s, ["kind", "claimKind", "text"]);
				text(s.text, "public claim");
				return {
					kind: "claim",
					claimKind: enumeration(s.claimKind, [
						"world_event",
						"world_fact",
						"life_claim",
					]),
					text: s.text,
				};
			}
			fields(s, ["kind", "text"]);
			text(s.text, "imaginative post");
			return { kind: enumeration(s.kind, ["imaginative"]), text: s.text };
		}),
		createdAt: revision(value.createdAt),
		createdLifeRevision: revision(value.createdLifeRevision, 1),
		withdrawn: flag(value.withdrawn),
	};
	if (
		post.id !==
			`pubpost-${lifeDigest({ worldId: post.worldId, jobId: post.jobId })}` ||
		post.worldId !== post.material.worldId ||
		post.author.agentId !== post.material.authorAgentId ||
		!post.segments.length ||
		!post.roots.length ||
		post.revision !== (post.withdrawn ? 2 : 1) ||
		post.createdLifeRevision < post.material.source.lifeRevision
	)
		throw Error("Invalid publication post source");
	return post;
}
type Row = {
	world_id: string;
	post_id: string;
	revision: number;
	post_json: string;
	digest: string;
};
function decode(row: Row): PublicationPost {
	const post = parsePost(JSON.parse(row.post_json));
	if (
		post.worldId !== row.world_id ||
		post.id !== row.post_id ||
		post.revision !== row.revision ||
		lifeDigest(post) !== row.digest
	)
		throw Error("Corrupt publication post row");
	return post;
}
/** The publication execution transaction owns insertion; deletion is a retained withdrawal. */
export class PublicationPosts {
	constructor(
		private readonly db: DatabaseSync,
		private readonly jobs: PublicationJobs,
	) {}
	get(worldId: string, postId: string): PublicationPost | null {
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_posts WHERE world_id=? AND post_id=?",
			)
			.get(identifier(worldId), identifier(postId)) as Row | undefined;
		if (!row) return null;
		const head = decode(row),
			history = (
				this.db
					.prepare(
						"SELECT * FROM life_publication_post_history WHERE world_id=? AND post_id=? ORDER BY revision",
					)
					.all(worldId, postId) as Row[]
			).map(decode),
			first = history[0];
		if (
			!first ||
			first.revision !== 1 ||
			first.withdrawn ||
			history.length !== head.revision ||
			history.some(
				(p, i) =>
					p.revision !== i + 1 ||
					lifeDigest({ ...p, revision: 1, withdrawn: false }) !==
						lifeDigest(first),
			) ||
			lifeDigest(history.at(-1)) !== lifeDigest(head)
		)
			throw Error("Missing or regressed publication post history");
		const receipt = this.db
			.prepare(
				"SELECT * FROM life_publication_post_receipts WHERE world_id=? AND post_id=?",
			)
			.get(worldId, postId);
		if (
			!receipt ||
			receipt["job_id"] !== head.jobId ||
			receipt["payload_digest"] !== lifeDigest(first)
		)
			throw Error("Missing publication delivery receipt");
		const source = this.jobs
			.history(worldId, head.jobId)
			.find(
				(job) => job.attemptId === head.attemptId && job.status === "ready",
			);
		if (
			!source ||
			lifeDigest(source.material) !== lifeDigest(head.material) ||
			lifeDigest(source.author) !== lifeDigest(head.author) ||
			lifeDigest(render(source)) !== lifeDigest(head.segments)
		)
			throw Error("Publication post differs from permitted decision");
		return head;
	}
	list(worldId: string): PublicationPost[] {
		return this.db
			.prepare(
				"SELECT post_id FROM life_publication_posts WHERE world_id=? ORDER BY rowid",
			)
			.all(identifier(worldId))
			.map((r) => {
				const post = this.get(worldId, String(r["post_id"]));
				if (!post) throw Error("Missing publication post");
				return post;
			});
	}
	/** Internal history proof; feed reads always use the current head and current policy. */
	at(worldId: string, postId: string, atRevision: number): PublicationPost {
		revision(atRevision, 1);
		if (!this.get(worldId, postId)) throw Error("Unknown publication post");
		const row = this.db
			.prepare(
				"SELECT * FROM life_publication_post_history WHERE world_id=? AND post_id=? AND revision=?",
			)
			.get(worldId, postId, atRevision) as Row | undefined;
		if (!row) throw Error("Unknown publication post revision");
		return decode(row);
	}
	private save(value: PublicationPost): void {
		const post = parsePost(value),
			json = canonicalLifeJson(post),
			hash = lifeDigest(post);
		this.db
			.prepare(
				"INSERT INTO life_publication_post_history(world_id,post_id,revision,post_json,digest) VALUES(?,?,?,?,?)",
			)
			.run(post.worldId, post.id, post.revision, json, hash);
		this.db
			.prepare(
				"INSERT INTO life_publication_posts(world_id,post_id,revision,post_json,digest) VALUES(?,?,?,?,?) ON CONFLICT(world_id,post_id) DO UPDATE SET revision=excluded.revision,post_json=excluded.post_json,digest=excluded.digest",
			)
			.run(post.worldId, post.id, post.revision, json, hash);
	}
	publish(
		job: PublicationJob,
		createdAt: number,
		createdLifeRevision: number,
		roots: PublicationPost["roots"],
	): PublicationPost {
		if (!job.material || !job.author || job.status !== "ready")
			throw Error("Publication job not ready");
		const id = `pubpost-${lifeDigest({ worldId: job.worldId, jobId: job.id })}`,
			prior = this.get(job.worldId, id);
		if (prior) {
			if (
				prior.attemptId !== job.attemptId ||
				lifeDigest(prior.material) !== lifeDigest(job.material) ||
				lifeDigest(prior.segments) !== lifeDigest(render(job))
			)
				throw Error("Publication delivery conflict");
			return prior;
		}
		const post = parsePost({
			version: job.version,
			worldId: job.worldId,
			id,
			revision: 1,
			jobId: job.id,
			attemptId: job.attemptId,
			material: job.material,
			author: job.author,
			roots,
			segments: render(job),
			createdAt,
			createdLifeRevision,
			withdrawn: false,
		});
		this.save(post);
		this.db
			.prepare(
				"INSERT INTO life_publication_post_receipts(world_id,job_id,post_id,payload_digest) VALUES(?,?,?,?)",
			)
			.run(post.worldId, job.id, id, lifeDigest(post));
		return post;
	}
	withdraw(
		worldId: string,
		postId: string,
		input: { requestKey: string; expectedRevision: number },
	): PublicationPost {
		jsonBoundary(input);
		fields(input, ["requestKey", "expectedRevision"]);
		identifier(input.requestKey);
		revision(input.expectedRevision, 1);
		const post = this.get(worldId, postId);
		if (!post) throw Error("Unknown publication post");
		const payload = lifeDigest({ postId, ...input }),
			receipt = this.db
				.prepare(
					"SELECT * FROM life_publication_post_requests WHERE world_id=? AND request_key=?",
				)
				.get(worldId, input.requestKey);
		if (receipt) {
			if (receipt["payload_digest"] !== payload)
				throw Error("Publication withdrawal conflict");
			return post;
		}
		if (post.revision !== input.expectedRevision)
			throw Error("Publication post revision conflict");
		const next = post.withdrawn
			? post
			: { ...post, revision: 2, withdrawn: true };
		if (!post.withdrawn) this.save(next);
		this.db
			.prepare(
				"INSERT INTO life_publication_post_requests(world_id,request_key,post_id,expected_revision,result_revision,payload_digest) VALUES(?,?,?,?,?,?)",
			)
			.run(
				worldId,
				input.requestKey,
				postId,
				input.expectedRevision,
				next.revision,
				payload,
			);
		return next;
	}
	validate(): void {
		for (const row of this.db
			.prepare(
				"SELECT world_id,post_id FROM life_publication_posts UNION SELECT world_id,post_id FROM life_publication_post_history UNION SELECT world_id,post_id FROM life_publication_post_receipts UNION SELECT world_id,post_id FROM life_publication_post_requests",
			)
			.all()) {
			const post = this.get(String(row["world_id"]), String(row["post_id"]));
			if (!post) throw Error("Missing publication post head");
			const receipts = this.db
				.prepare(
					"SELECT * FROM life_publication_post_requests WHERE world_id=? AND post_id=?",
				)
				.all(post.worldId, post.id);
			let withdrawal = false;
			for (const receipt of receipts) {
				const requestKey = identifier(receipt["request_key"]),
					expectedRevision = revision(receipt["expected_revision"], 1);
				if (
					!post.withdrawn ||
					![1, 2].includes(expectedRevision) ||
					receipt["result_revision"] !== 2 ||
					digest(receipt["payload_digest"]) !==
						lifeDigest({ postId: post.id, requestKey, expectedRevision })
				)
					throw Error("Corrupt publication withdrawal receipt");
				if (expectedRevision === 1) {
					if (withdrawal) throw Error("Duplicate publication withdrawal");
					withdrawal = true;
				}
			}
			if (post.withdrawn !== withdrawal)
				throw Error("Missing publication withdrawal receipt");
		}
	}
}
