import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { PublicationJobs } from "../src/world/publication-jobs.ts";
import { PublicationPosts } from "../src/world/publication-posts.ts";
import {
	parsePublicationJob,
	parsePublicationMaterial,
	publicationAttemptId,
	publicationJobId,
	publicationReplyJobId,
} from "../src/world/publication-record-validation.ts";
import { parseReplyPublicationPost } from "../src/world/publication-reply-records.ts";
import fixture from "./fixtures/life-publication-reply-records.json";

// Frozen JSON and golden digests were computed independently with Python's
// sorted JSON serialization and hashlib before production changes.
function first<T>(items: T[]): T {
	const item = items[0];
	if (!item) throw Error("Missing codec fixture item");
	return item;
}

function reseal<T extends { id: string; digest: string }>(material: T): T {
	const { id: _id, digest: _digest, ...body } = material;
	const identified = { ...body, id: `material-${lifeDigest(body)}` };
	return { ...material, ...identified, digest: lifeDigest(identified) };
}

/** Exercise the private post codec through its real SQLite read path.
 * The job-history seam is a fixture: ancestor/storage authentication is not
 * claimed by these pure record tests. Adjacent suites own the real job history.
 */
function readPost<
	T extends { worldId: string; id: string; revision: number; jobId: string },
>(post: T, job: unknown) {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(`
			CREATE TABLE life_publication_posts(world_id,post_id,revision,post_json,digest);
			CREATE TABLE life_publication_post_history(world_id,post_id,revision,post_json,digest);
			CREATE TABLE life_publication_post_receipts(world_id,post_id,job_id,payload_digest);
		`);
		const stored = post;
		for (const table of [
			"life_publication_posts",
			"life_publication_post_history",
		])
			db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run(
				stored.worldId,
				stored.id,
				stored.revision,
				canonicalLifeJson(post),
				lifeDigest(post),
			);
		db.prepare(
			"INSERT INTO life_publication_post_receipts VALUES(?,?,?,?)",
		).run(stored.worldId, stored.id, stored.jobId, lifeDigest(post));
		class JobHistory extends PublicationJobs {
			override history() {
				return [parsePublicationJob(job)];
			}
		}
		return new PublicationPosts(db, new JobHistory(db)).get(
			stored.worldId,
			stored.id,
		);
	} finally {
		db.close();
	}
}

test("event v1 material, job and stored post retain golden bytes and hashes", () => {
	const { material, job, post } = fixture.event;
	for (const [parsed, original, hash] of [
		[
			parsePublicationMaterial(material),
			material,
			fixture.golden.eventMaterial,
		],
		[parsePublicationJob(job), job, fixture.golden.eventJob],
		[readPost(post, job), post, fixture.golden.eventPost],
	] as const) {
		expect(canonicalLifeJson(parsed)).toBe(canonicalLifeJson(original));
		expect(lifeDigest(parsed)).toBe(hash);
	}
	expect(publicationJobId("world", "intent", "a", "friends")).toBe(job.id);
	expect(publicationAttemptId(job.id, 1)).toBe(job.attemptId);
	expect(Object.keys(parsePublicationJob(job))).toEqual([
		"version",
		"id",
		"worldId",
		"revision",
		"intentId",
		"authorAgentId",
		"recipientId",
		"attempt",
		"attemptId",
		"status",
		"material",
		"author",
		"modelSettingsRevision",
		"decision",
		"postId",
		"error",
	]);
	expect(() =>
		parsePublicationMaterial(reseal({ ...material, allowedClaims: [] })),
	).toThrow();
});

test("reply v2 material roundtrips with real origin, frozen parent and whole-envelope digest", () => {
	const parsed = parsePublicationMaterial(fixture.reply.material);
	expect(canonicalLifeJson(parsed)).toBe(
		canonicalLifeJson(fixture.reply.material),
	);
	expect(lifeDigest(parsed)).toBe(fixture.golden.replyMaterial);
	const empty = reseal({ ...fixture.reply.material, allowedClaims: [] });
	expect(parsePublicationMaterial(empty).allowedClaims).toEqual([]);
	for (const key of ["parent", "authority", "parentRoots"] as const) {
		const changed = structuredClone(fixture.reply.material);
		if (key === "parent") changed.parent.createdAt++;
		if (key === "authority")
			Object.assign(changed.authority, {
				grants: [{ id: "grant", revision: 1 }],
			});
		if (key === "parentRoots") first(changed.parentRoots).depth++;
		expect(() => parsePublicationMaterial(changed)).toThrow();
	}
});

test.each(["ready", "skipped", "published"])(
	"reply v2 %s job has typed identity and outcome",
	(status) => {
		const postId = status === "published" ? fixture.reply.post.id : null;
		const job = {
			...fixture.reply.job,
			status,
			postId,
			decision:
				status === "skipped"
					? { kind: "no_reply" }
					: fixture.reply.job.decision,
		};
		expect(canonicalLifeJson(parsePublicationJob(job))).toBe(
			canonicalLifeJson(job),
		);
		if (status === "ready")
			expect(lifeDigest(parsePublicationJob(job))).toBe(
				fixture.golden.replyJob,
			);
	},
);

test("reply v2 stored post routes its codec and preserves generated segment tags", () => {
	const parsed = readPost(fixture.reply.post, fixture.reply.job);
	expect(canonicalLifeJson(parsed)).toBe(canonicalLifeJson(fixture.reply.post));
	expect(lifeDigest(parsed)).toBe(fixture.golden.replyPost);
});

test("reply identity hashes the typed parent source and keeps event IDs distinct", () => {
	expect(
		publicationReplyJobId("world", fixture.event.post.id, "b", "friends"),
	).toBe(fixture.reply.job.id);
	expect(
		publicationJobId("world", fixture.event.post.id, "b", "friends"),
	).not.toBe(fixture.reply.job.id);
});

test("reply job validates all frozen ownership links after identity is recomputed", () => {
	for (const patch of [
		{ worldId: "other" },
		{ authorAgentId: "other" },
		{ recipientId: "other" },
		{ source: { kind: "reply", parentPostId: "other" } },
	]) {
		const job = { ...fixture.reply.job, ...patch };
		job.id = publicationReplyJobId(
			job.worldId,
			job.source.parentPostId,
			job.authorAgentId,
			job.recipientId,
		);
		job.attemptId = publicationAttemptId(job.id, job.attempt);
		expect(() => parsePublicationJob(job)).toThrow(
			/material (ownership|source) mismatch/,
		);
	}
	for (const patch of [
		{ author: { ...fixture.reply.job.author, agentId: "other" } },
		{ author: null },
		{ modelSettingsRevision: null },
		{ material: null },
		{ attempt: 2 },
		{ attempt: Number.MAX_SAFE_INTEGER + 1 },
		{ revision: 0 },
		{ intentId: "intent" },
		{ source: { kind: "event", parentPostId: fixture.event.post.id } },
		{ material: fixture.event.material },
	])
		expect(() =>
			parsePublicationJob({ ...fixture.reply.job, ...patch }),
		).toThrow();
	expect(() =>
		parsePublicationJob({
			...fixture.event.job,
			material: fixture.reply.material,
		}),
	).toThrow();
});

test("reply job state machine admits empty pending and failure states, and rejects mixed outcomes", () => {
	const pending = {
		...fixture.reply.job,
		status: "pending",
		material: null,
		author: null,
		modelSettingsRevision: null,
		decision: null,
	};
	expect(canonicalLifeJson(parsePublicationJob(pending))).toBe(
		canonicalLifeJson(pending),
	);
	for (const status of ["prepared", "unknown", "withheld", "failed"]) {
		const job = {
			...fixture.reply.job,
			status,
			decision: null,
			error: status === "prepared" ? null : "unavailable",
		};
		expect(canonicalLifeJson(parsePublicationJob(job))).toBe(
			canonicalLifeJson(job),
		);
	}
	for (const patch of [
		{ status: "pending" },
		{ status: "prepared" },
		{ status: "ready", decision: null },
		{ status: "unknown", decision: null, error: null },
		{ status: "failed", decision: null, error: null },
		{ status: "skipped" },
		{ status: "skipped", decision: { kind: "no_post" } },
		{ status: "published" },
		{ postId: fixture.reply.post.id },
		{ status: "published", postId: "other" },
		{
			status: "published",
			postId: fixture.reply.post.id,
			decision: { kind: "no_reply" },
		},
		{ error: "unexpected" },
		{
			decision: {
				kind: "post",
				segments: [{ kind: "claim", claimId: "hidden" }],
			},
		},
	])
		expect(() =>
			parsePublicationJob({ ...fixture.reply.job, ...patch }),
		).toThrow();
	expect(() =>
		parsePublicationJob({
			...fixture.event.job,
			status: "skipped",
			decision: { kind: "no_reply" },
		}),
	).toThrow();
	const skipped = {
		...fixture.event.job,
		status: "skipped",
		decision: { kind: "no_post" },
	};
	expect(canonicalLifeJson(parsePublicationJob(skipped))).toBe(
		canonicalLifeJson(skipped),
	);
});

test("reply posts enforce exact roots plus one, claim tags, ownership and withdrawal revisions", () => {
	const withdrawn = { ...fixture.reply.post, revision: 2, withdrawn: true };
	expect(canonicalLifeJson(parseReplyPublicationPost(withdrawn))).toBe(
		canonicalLifeJson(withdrawn),
	);
	for (const patch of [
		{ roots: [] },
		{ roots: fixture.event.post.roots },
		{ roots: [{ rootId: "other", depth: 1 }] },
		{ roots: [{ rootId: "root-a", depth: 2 }] },
		{ roots: [...fixture.reply.post.roots, ...fixture.reply.post.roots] },
		{ roots: [{ rootId: "root-a", depth: Number.MAX_SAFE_INTEGER + 1 }] },
		{ segments: [] },
		{ segments: [{ kind: "user_authored", text: "A bell rang." }] },
		{
			segments: [
				{ kind: "claim", claimKind: "world_fact", text: "A bell rang." },
			],
		},
		{
			segments: [{ kind: "claim", claimKind: "world_event", text: "Hidden." }],
		},
		{ segments: [{ kind: "imaginative", text: "" }] },
		{ worldId: "other" },
		{ id: "other" },
		{ jobId: "other" },
		{ author: { ...fixture.reply.post.author, agentId: "other" } },
		{ createdLifeRevision: 7 },
		{ createdLifeRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ revision: 2 },
		{ revision: 3 },
		{ withdrawn: true },
		{ material: fixture.event.material },
		{ extra: true },
	])
		expect(() =>
			parseReplyPublicationPost({ ...fixture.reply.post, ...patch }),
		).toThrow();
	const material = reseal({
		...fixture.reply.material,
		parentRoots: [{ rootId: "root-a", depth: Number.MAX_SAFE_INTEGER }],
	});
	expect(() =>
		parseReplyPublicationPost({ ...fixture.reply.post, material }),
	).toThrow();
	expect(() =>
		readPost(
			{ ...fixture.event.post, material: fixture.reply.material },
			fixture.event.job,
		),
	).toThrow();
});

function linkedMaterial(kind: "reply" | "reshare", owner: "post" | "reply") {
	const material = structuredClone(fixture.reply.material);
	return reseal({
		...material,
		source: { ...material.source, parentOwner: owner },
		parent: { ...material.parent, kind, parentPostId: "ancestor" },
		authority: {
			...material.authority,
			posts: [
				{ id: "ancestor", kind: "post", revision: 1 },
				{ id: material.parent.id, kind: owner, revision: 1 },
			],
		},
	});
}

test("generated replies, viewer replies and reshares retain the storage-owner distinction", () => {
	for (const material of [
		linkedMaterial("reply", "post"),
		linkedMaterial("reshare", "reply"),
	]) {
		expect(canonicalLifeJson(parsePublicationMaterial(material))).toBe(
			canonicalLifeJson(material),
		);
	}
	const linked = linkedMaterial("reply", "reply");
	const user = {
		...linked,
		parent: {
			...linked.parent,
			author: { kind: "viewer" },
			segments: [{ kind: "user_authored", text: "A bell rang." }],
		},
	};
	expect(() => parsePublicationMaterial(reseal(user))).toThrow(
		"not supported by visible parent",
	);
	expect(
		parsePublicationMaterial(reseal({ ...user, allowedClaims: [] }))
			.allowedClaims,
	).toEqual([]);
	const imagined = {
		...fixture.reply.material,
		parent: {
			...fixture.reply.material.parent,
			segments: [{ kind: "imaginative", text: "A bell rang." }],
		},
	};
	expect(() => parsePublicationMaterial(reseal(imagined))).toThrow(
		"not supported by visible parent",
	);
	expect(
		parsePublicationMaterial(reseal({ ...imagined, allowedClaims: [] }))
			.allowedClaims,
	).toEqual([]);
});

test("local cycles and missing direct ancestor references are rejected without recursive parent parsing", () => {
	const linked = linkedMaterial("reply", "post");
	expect(() =>
		parsePublicationMaterial(
			reseal({
				...linked,
				parent: { ...linked.parent, parentPostId: linked.parent.id },
			}),
		),
	).toThrow("Invalid publication parent post");
	expect(() =>
		parsePublicationMaterial(
			reseal({
				...linked,
				authority: {
					...linked.authority,
					posts: linked.authority.posts.filter((p) => p.id !== "ancestor"),
				},
			}),
		),
	).toThrow("Missing publication parent ancestor");
	const cyclic = {
		...fixture.reply.material,
		authority: {
			...fixture.reply.material.authority,
			posts: [
				...fixture.reply.material.authority.posts,
				{ id: fixture.reply.post.id, kind: "post", revision: 1 },
			],
		},
	};
	expect(() => parsePublicationMaterial(reseal(cyclic))).toThrow(
		"Cyclic publication reply authority",
	);
});

test.each([
	[
		"parent id",
		(m: typeof fixture.reply.material) => {
			m.source.parentPostId = "other";
		},
	],
	[
		"parent revision",
		(m: typeof fixture.reply.material) => {
			m.source.parentPostRevision++;
		},
	],
	[
		"parent owner",
		(m: typeof fixture.reply.material) => {
			m.source.parentOwner = "reply";
		},
	],
	[
		"authority settings",
		(m: typeof fixture.reply.material) => {
			m.authority.settingsRevision++;
		},
	],
	[
		"authority revision",
		(m: typeof fixture.reply.material) => {
			first(m.authority.posts).revision++;
		},
	],
	[
		"missing authority",
		(m: typeof fixture.reply.material) => {
			m.authority.posts = [];
		},
	],
	[
		"duplicate authority",
		(m: typeof fixture.reply.material) => {
			m.authority.posts.push({ ...first(m.authority.posts) });
		},
	],
	[
		"self author",
		(m: typeof fixture.reply.material) => {
			m.parent.author.agentId = m.authorAgentId;
		},
	],
	[
		"origin world",
		(m: typeof fixture.reply.material) => {
			m.source.origin.eventId = "other:3";
		},
	],
	[
		"origin revision",
		(m: typeof fixture.reply.material) => {
			m.source.origin.worldRevision++;
		},
	],
	[
		"old world snapshot",
		(m: typeof fixture.reply.material) => {
			m.source.worldRevision = 2;
		},
	],
	[
		"old life snapshot",
		(m: typeof fixture.reply.material) => {
			m.source.lifeRevision = 4;
		},
	],
	[
		"empty roots",
		(m: typeof fixture.reply.material) => {
			m.parentRoots = [];
		},
	],
	[
		"duplicate roots",
		(m: typeof fixture.reply.material) => {
			m.parentRoots.push({ ...first(m.parentRoots) });
		},
	],
	[
		"unsafe depth",
		(m: typeof fixture.reply.material) => {
			first(m.parentRoots).depth = Number.MAX_SAFE_INTEGER + 1;
		},
	],
	[
		"unsafe revision",
		(m: typeof fixture.reply.material) => {
			m.source.lifeRevision = Number.MAX_SAFE_INTEGER + 1;
		},
	],
	[
		"unposted claim",
		(m: typeof fixture.reply.material) => {
			first(m.allowedClaims).text = "A hidden bell rang.";
		},
	],
	[
		"imagination laundering",
		(m: typeof fixture.reply.material) => {
			m.parent.segments = [{ kind: "imaginative", text: "A bell rang." }];
		},
	],
	[
		"user laundering",
		(m: typeof fixture.reply.material) => {
			m.parent.segments = [{ kind: "user_authored", text: "A bell rang." }];
		},
	],
	[
		"claim kind laundering",
		(m: typeof fixture.reply.material) => {
			first(m.parent.segments).claimKind = "life_claim";
		},
	],
] as const)("reply material rejects %s even after rehash", (_name, change) => {
	const material = structuredClone(fixture.reply.material);
	change(material);
	expect(() => parsePublicationMaterial(reseal(material))).toThrow();
});

test("reply records reject executable properties without running getters", () => {
	let reads = 0;
	for (const [original, parse] of [
		[fixture.reply.material, parsePublicationMaterial],
		[fixture.reply.job, parsePublicationJob],
		[fixture.reply.post, parseReplyPublicationPost],
	] as const) {
		for (const key of ["version", "source"]) {
			const value = { ...original };
			Object.defineProperty(value, key, {
				enumerable: true,
				get() {
					reads++;
					throw Error("executed");
				},
			});
			expect(() => parse(value)).toThrow("Invalid LIFE JSON property");
		}
	}
	expect(reads).toBe(0);
});

test("nested accessors, sparse lists and excessive input are rejected before executable reads", () => {
	let reads = 0;
	for (const target of [
		"origin",
		"author",
		"claim",
		"authority",
		"root",
	] as const) {
		const value = structuredClone(fixture.reply.material);
		const object = {
			origin: value.source.origin,
			author: value.parent.author,
			claim: first(value.parent.segments),
			authority: first(value.authority.posts),
			root: first(value.parentRoots),
		}[target];
		Object.defineProperty(object, Object.keys(object)[0] ?? "extra", {
			enumerable: true,
			get() {
				reads++;
				return "executed";
			},
		});
		expect(() => parsePublicationMaterial(value)).toThrow(
			"Invalid LIFE JSON property",
		);
	}
	expect(reads).toBe(0);
	const sparse = structuredClone(fixture.reply.material);
	sparse.parent.segments.length = 3;
	expect(() => parsePublicationMaterial(sparse)).toThrow(
		"Invalid LIFE JSON list",
	);
	const oversized = structuredClone(fixture.reply.material);
	first(oversized.parent.segments).text = "x".repeat(32769);
	expect(() => parsePublicationMaterial(reseal(oversized))).toThrow(
		"Invalid world public claim",
	);
});

test("pure codec requires typed visible support but leaves ancestor source-ID authentication to storage", () => {
	const material = structuredClone(fixture.reply.material);
	const claim = first(material.allowedClaims);
	claim.sourceId = "world:2";
	claim.id = `claim-${lifeDigest({ kind: claim.kind, id: claim.sourceId })}`;
	const rehashed = reseal(material);
	expect(canonicalLifeJson(parsePublicationMaterial(rehashed))).toBe(
		canonicalLifeJson(rehashed),
	);
});

test("explicit versions, unknown fields, scenes and JSON cycles fail closed", () => {
	for (const version of [0, 3, "2", null]) {
		expect(() =>
			parsePublicationMaterial({ ...fixture.reply.material, version }),
		).toThrow();
		expect(() =>
			parsePublicationJob({ ...fixture.reply.job, version }),
		).toThrow();
	}
	for (const value of [
		{ ...fixture.reply.material, extra: true },
		{
			...fixture.reply.material,
			permittedScene: fixture.reply.material.parent,
		},
		{
			...fixture.reply.material,
			source: { ...fixture.reply.material.source, eventId: "world:3" },
		},
	])
		expect(() => parsePublicationMaterial(reseal(value))).toThrow();
	const cyclic = structuredClone(fixture.reply.material);
	Object.assign(cyclic.parent, { cycle: cyclic });
	expect(() => parsePublicationMaterial(cyclic)).toThrow("Invalid LIFE JSON");
});
