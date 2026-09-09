import { expect, test } from "bun:test";
import { lifeDigest } from "../src/world/life-json.ts";
import { PublicationFeed } from "../src/world/publication-feed.ts";
import type { PublicationInteraction } from "../src/world/publication-interactions.ts";
import {
	parsePublicationMaterial,
	publicationAttemptId,
	publicationReplyJobId,
} from "../src/world/publication-record-validation.ts";
import type { PublicationReplyPost } from "../src/world/publication-reply-posts.ts";
import { parseReplyPublicationPost } from "../src/world/publication-reply-records.ts";
import type {
	EventPublicationPost,
	PublicationMaterial,
	PublicationPost,
	PublicationPrincipal,
	PublicLifePost,
	ReplyPublicationPost,
} from "../src/world/publication-types.ts";
import records from "./fixtures/life-publication-reply-records.json";

const principal: PublicationPrincipal = { kind: "agent", agentId: "a" };
const claim: PublicLifePost["segments"][number] = {
	kind: "claim",
	claimKind: "world_event",
	text: "A bell rang.",
};

function fixture() {
	const material = parsePublicationMaterial(records.event.material);
	if (material.version !== 1) throw Error("Expected event fixture");
	const root: EventPublicationPost = {
		...records.event.post,
		version: 1,
		material,
		segments: [
			{ kind: "claim", claimKind: "world_event", text: "A bell rang." },
			{ kind: "imaginative", text: "Perhaps tomorrow." },
		],
	};
	const generated = parseReplyPublicationPost(records.reply.post);
	const posts = new Map<string, PublicationPost>([
		[root.id, root],
		[generated.id, generated],
	]);
	const replies = new Map<string, PublicationReplyPost>();
	const interactions = new Map<string, PublicationInteraction>();
	const checked: string[] = [],
		denied = new Set<string>();
	const current = new Map<string, PublicationMaterial>();
	const feed = new PublicationFeed(
		{
			get: (_world, id) => posts.get(id) ?? null,
			list: () => [...posts.values()],
		},
		{
			get: () => {
				throw Error("Legacy ancestor grants are not collected");
			},
		},
		{
			recipients: () => ({
				revision: 1,
				recipientIds: ["friends", "others"],
				agents: [
					{ agentId: "a", recipientId: "friends" },
					{ agentId: "outsider", recipientId: "others" },
				],
			}),
			material: (value) => {
				checked.push(value.id);
				return denied.has(value.id) ? null : (current.get(value.id) ?? value);
			},
		},
		{
			posts: {
				get: (_world, id) => replies.get(id) ?? null,
				list: () => [...replies.values()],
			},
			interactions: {
				get: (_world, id) => {
					const interaction = interactions.get(id);
					if (!interaction) throw Error("Missing fixture interaction");
					return interaction;
				},
			},
		},
	);
	return {
		root,
		generated,
		posts,
		replies,
		interactions,
		feed,
		checked,
		denied,
		current,
	};
}

function addUser(
	f: ReturnType<typeof fixture>,
	parent: PublicationPost | PublicationReplyPost,
	action: { kind: "reply"; text: string } | { kind: "reshare" },
) {
	const id = `user-${f.replies.size}`;
	const post: PublicationReplyPost = {
		version: 1,
		worldId: "world",
		id,
		revision: 1,
		interactionId: `interaction-${id}`,
		parentPostId: parent.id,
		principal: { kind: "viewer", grantId: "legacy-grant" },
		audience: ["friends"],
		roots: parent.roots.map((root) => ({ ...root, depth: root.depth + 1 })),
		createdAt: parent.createdAt + 1,
		createdLifeRevision: parent.createdLifeRevision + 1,
		withdrawn: false,
	};
	f.replies.set(id, post);
	f.interactions.set(post.interactionId, {
		version: 1,
		worldId: post.worldId,
		id: post.interactionId,
		requestKey: post.interactionId,
		principal: post.principal,
		parentPostId: parent.id,
		expectedPostRevision: parent.revision,
		action,
		roots: post.roots,
		audience: post.audience,
		createdAt: post.createdAt,
		lifeRevision: post.createdLifeRevision,
		settingsRevision: 1,
		postId: id,
		processing: "stopped",
		observationIds: [],
	});
	return post;
}

function addGeneratedAfterUser(
	f: ReturnType<typeof fixture>,
	user: PublicationReplyPost,
) {
	const source = f.generated.material;
	const body = {
		...source,
		authorAgentId: "a",
		allowedClaims: [],
		source: {
			...source.source,
			parentOwner: "reply",
			parentPostId: user.id,
			parentPostRevision: user.revision,
		},
		parent: {
			id: user.id,
			revision: user.revision,
			kind: "reply",
			parentPostId: user.parentPostId,
			author: { kind: "viewer" },
			segments: [{ kind: "user_authored", text: "A bell rang." }],
			createdAt: user.createdAt,
		},
		parentRoots: user.roots,
		authority: {
			settingsRevision: 1,
			grants: [{ id: "legacy-grant", revision: 1 }],
			posts: [
				{ id: f.root.id, kind: "post", revision: 1 },
				{ id: f.generated.id, kind: "post", revision: 1 },
				{ id: user.id, kind: "reply", revision: 1 },
			],
		},
	};
	const { id: _id, digest: _digest, ...value } = body;
	const identified = { ...value, id: `material-${lifeDigest(value)}` };
	const jobId = publicationReplyJobId("world", user.id, "a", "friends");
	const post = parseReplyPublicationPost({
		...f.generated,
		jobId,
		attemptId: publicationAttemptId(jobId, 1),
		id: `pubpost-${lifeDigest({ worldId: "world", jobId })}`,
		author: { ...f.root.author, agentId: "a" },
		material: { ...identified, digest: lifeDigest(identified) },
		roots: user.roots.map((root) => ({ ...root, depth: root.depth + 1 })),
		segments: [{ kind: "imaginative", text: "Perhaps we heard it together." }],
		createdAt: user.createdAt + 1,
		createdLifeRevision: user.createdLifeRevision + 1,
	});
	f.posts.set(post.id, post);
	return post;
}

function mixed() {
	const f = fixture();
	const user = addUser(f, f.generated, { kind: "reply", text: "A bell rang." });
	const child = addGeneratedAfterUser(f, user);
	const share = addUser(f, child, { kind: "reshare" });
	return { ...f, user, child, share };
}

test("generated v2 is a reply with its own typed segments and every generated ancestor checked", () => {
	const f = fixture();
	expect(f.feed.post("world", principal, f.generated.id)).toEqual({
		id: f.generated.id,
		revision: 1,
		kind: "reply",
		parentPostId: f.root.id,
		author: { kind: "agent", agentId: "b", name: "B" },
		segments: [claim, { kind: "imaginative", text: "Perhaps tomorrow." }],
		createdAt: f.generated.createdAt,
		reactions: [],
	});
	expect(f.checked.sort()).toEqual(
		[f.root.material.id, f.generated.material.id].sort(),
	);
});

test("mixed ancestry preserves generated, user-authored and reshare segment provenance and roots", () => {
	const f = mixed();
	expect(f.feed.post("world", principal, f.user.id)?.segments).toEqual([
		{ kind: "user_authored", text: "A bell rang." },
	]);
	expect(f.feed.post("world", principal, f.child.id)).toMatchObject({
		kind: "reply",
		parentPostId: f.user.id,
		author: { kind: "agent", agentId: "a" },
		segments: [{ kind: "imaginative", text: "Perhaps we heard it together." }],
	});
	f.checked.length = 0;
	expect(f.feed.post("world", principal, f.share.id)).toMatchObject({
		kind: "reshare",
		parentPostId: f.child.id,
		segments: [{ kind: "imaginative", text: "Perhaps we heard it together." }],
	});
	expect(f.checked.sort()).toEqual(
		[f.root.material.id, f.generated.material.id, f.child.material.id].sort(),
	);
	expect(f.feed.parent("world", principal, f.share.id)).toEqual({
		id: f.share.id,
		revision: 1,
		audience: ["friends"],
		roots: [{ rootId: "root-a", depth: 4 }],
	});
	const userShare = addUser(f, f.user, { kind: "reshare" });
	expect(f.feed.post("world", principal, userShare.id)?.segments).toEqual([
		{ kind: "user_authored", text: "A bell rang." },
	]);
});

test.each(["root", "generated", "child"] as const)(
	"current material denial at %s hides all descendants on the next read",
	(owner) => {
		const f = mixed();
		expect(f.feed.post("world", principal, f.share.id)).not.toBeNull();
		f.denied.add(f[owner].material.id);
		expect(f.feed.post("world", principal, f.share.id)).toBeNull();
		expect(f.feed.parent("world", principal, f.child.id)).toBeNull();
		expect(
			f.feed
				.query("world", principal, { limit: 100, after: null })
				.items.some((post) => post.id === f.share.id),
		).toBe(false);
	},
);

test("changed current claim material in a generated ancestor withholds a later imaginative reply", () => {
	const f = mixed();
	f.current.set(f.generated.material.id, {
		...f.generated.material,
		allowedClaims: [],
	});
	expect(f.feed.post("world", principal, f.child.id)).toBeNull();
});

test.each(["root", "generated", "user", "child"] as const)(
	"withdrawal of %s hides descendants while its own parent stays visible",
	(owner) => {
		const f = mixed();
		f[owner].withdrawn = true;
		f[owner].revision = 2;
		expect(f.feed.post("world", principal, f.share.id)).toBeNull();
		expect(f.feed.parent("world", principal, f.child.id)).toBeNull();
		const parentId = {
			root: null,
			generated: f.root.id,
			user: f.generated.id,
			child: f.user.id,
		}[owner];
		if (parentId)
			expect(f.feed.post("world", principal, parentId)).not.toBeNull();
	},
);

test.each(["root", "generated", "user", "child"] as const)(
	"audience denial at %s cannot be broadened by descendants",
	(owner) => {
		const f = mixed();
		const post = f[owner];
		if ("material" in post) post.material.audience = ["others"];
		else post.audience = ["others"];
		expect(f.feed.post("world", principal, f.share.id)).toBeNull();
		expect(f.feed.parent("world", principal, f.child.id)).toBeNull();
		expect(
			f.feed.post("world", { kind: "agent", agentId: "outsider" }, f.share.id),
		).toBeNull();
	},
);

test("parent audience is intersected across generated and user owners", () => {
	const f = mixed();
	f.root.material.audience = ["friends", "others"];
	f.generated.material.audience = ["friends", "others"];
	f.child.material.audience = ["friends", "others"];
	f.share.audience = ["friends", "others"];
	expect(f.feed.parent("world", principal, f.share.id)?.audience).toEqual([
		"friends",
	]);
});

test.each(["mixed", "generated"] as const)(
	"%s parent cycles fail closed",
	(kind) => {
		const f = mixed();
		f.generated.material.source.parentPostId =
			kind === "mixed" ? f.user.id : f.child.id;
		if (kind === "generated")
			f.child.material.source.parentPostId = f.generated.id;
		expect(() => f.feed.post("world", principal, f.child.id)).toThrow(
			"Corrupt publication parent cycle",
		);
		expect(() => f.feed.parent("world", principal, f.share.id)).toThrow(
			"Corrupt publication parent cycle",
		);
		expect(() =>
			f.feed.query("world", principal, { limit: 100, after: null }),
		).toThrow("Corrupt publication parent cycle");
	},
);

test.each(["root", "generated", "user"] as const)(
	"missing %s ancestor hides generated descendants",
	(owner) => {
		const f = mixed();
		f.posts.delete(f[owner].id);
		f.replies.delete(f[owner].id);
		expect(f.feed.post("world", principal, f.child.id)).toBeNull();
	},
);

test("mixed feed pagination displays each owner once and invalidates cursors after child withdrawal", () => {
	const f = mixed();
	const page = f.feed.query("world", principal, { limit: 2, after: null });
	expect(page.items.map((post) => [post.id, post.kind])).toEqual([
		[f.share.id, "reshare"],
		[f.child.id, "reply"],
	]);
	expect(page.nextCursor).not.toBeNull();
	const next = f.feed.query("world", principal, {
		limit: 3,
		after: page.nextCursor,
	});
	expect(next.items.map((post) => [post.id, post.kind])).toEqual([
		[f.user.id, "reply"],
		[f.generated.id, "reply"],
		[f.root.id, "post"],
	]);
	expect(next.nextCursor).toBeNull();
	f.child.withdrawn = true;
	f.child.revision = 2;
	expect(() =>
		f.feed.query("world", principal, { limit: 3, after: page.nextCursor }),
	).toThrow("Publication cursor scope changed");
});

test("legacy public bytes and ancestor grant reads are unchanged", () => {
	const f = fixture();
	expect(JSON.stringify(f.feed.post("world", principal, f.root.id))).toBe(
		JSON.stringify({
			id: f.root.id,
			revision: 1,
			kind: "post",
			author: { kind: "agent", agentId: "a", name: "A" },
			segments: [claim, { kind: "imaginative", text: "Perhaps tomorrow." }],
			createdAt: f.root.createdAt,
			reactions: [],
		}),
	);
	const user = addUser(f, f.root, { kind: "reply", text: "A bell rang." });
	expect(f.feed.post("world", principal, user.id)).toEqual({
		id: user.id,
		revision: 1,
		kind: "reply",
		parentPostId: f.root.id,
		createdAt: user.createdAt,
		author: { kind: "viewer" },
		segments: [{ kind: "user_authored", text: "A bell rang." }],
		reactions: [],
	});
	const share = addUser(f, f.root, { kind: "reshare" });
	const visible = f.feed.post("world", principal, share.id);
	expect(visible?.segments).toEqual([
		claim,
		{ kind: "imaginative", text: "Perhaps tomorrow." },
	]);
	if (!visible) throw Error("Missing reshare");
	visible.segments[0] = { kind: "user_authored", text: "Changed by reader" };
	expect(f.feed.post("world", principal, share.id)?.segments).toEqual([
		claim,
		{ kind: "imaginative", text: "Perhaps tomorrow." },
	]);
});

test.each(["reaction", "generated_reply"] as const)(
	"a %s interaction cannot be served through the user reply-post owner",
	(kind) => {
		const f = mixed();
		const interaction = f.interactions.get(f.user.interactionId);
		if (!interaction) throw Error("Missing fixture interaction");
		// Corrupt the otherwise complete user-owner fixture at its read port.
		Object.assign(interaction, {
			action:
				kind === "reaction"
					? { kind, reactionId: "support", active: true }
					: { kind, segments: f.generated.segments },
		});
		expect(() => f.feed.post("world", principal, f.user.id)).toThrow();
		expect(() => f.feed.post("world", principal, f.child.id)).toThrow();
	},
);

test("100000 alternating generated and reshare ancestors are iterative and keep root authority", () => {
	const f = fixture(),
		depth = 100000;
	const seed = addUser(f, f.generated, { kind: "reshare" });
	const interaction = f.interactions.get(seed.interactionId);
	if (!interaction) throw Error("Missing fixture interaction");
	let checked = 0;
	// Typed read-port fixtures model an arbitrarily deep stored history. Storage
	// provenance/digests are tested by the SQL owners, not synthesized per depth here.
	const feed = new PublicationFeed(
		{
			list: () => [],
			get: (_world, id): PublicationPost | null => {
				if (id === f.root.id) return f.root;
				const n = Number(id.slice(1));
				if (!Number.isInteger(n) || n < 1 || n % 2 === 0) return null;
				const generated: ReplyPublicationPost = {
					...f.generated,
					id,
					material: {
						...f.generated.material,
						source: {
							...f.generated.material.source,
							parentPostId: n === 1 ? f.root.id : `p${n - 1}`,
						},
					},
					roots: [{ rootId: "root-a", depth: n }],
				};
				return generated;
			},
		},
		{
			get: () => {
				throw Error("Legacy grant lookup");
			},
		},
		{
			recipients: () => ({
				revision: 1,
				recipientIds: ["friends"],
				agents: [{ agentId: "a", recipientId: "friends" }],
			}),
			material: (material) => {
				checked++;
				return material;
			},
		},
		{
			posts: {
				list: () => [],
				get: (_world, id) => ({
					...seed,
					id,
					parentPostId: `p${Number(id.slice(1)) - 1}`,
					roots: [{ rootId: "root-a", depth: Number(id.slice(1)) }],
				}),
			},
			interactions: { get: () => interaction },
		},
	);
	expect(feed.post("world", principal, `p${depth}`)?.segments).toEqual([
		claim,
		{ kind: "imaginative", text: "Perhaps tomorrow." },
	]);
	expect(checked).toBe(depth / 2 + 1);
	expect(feed.parent("world", principal, `p${depth}`)?.roots).toEqual([
		{ rootId: "root-a", depth },
	]);
	f.root.withdrawn = true;
	expect(feed.post("world", principal, `p${depth}`)).toBeNull();
});
