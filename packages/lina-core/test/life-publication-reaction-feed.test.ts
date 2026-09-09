import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson } from "../src/world/life-json.ts";
import { PublicationFeed } from "../src/world/publication-feed.ts";
import {
	PUBLICATION_GRANTS_SCHEMA,
	PublicationGrants,
} from "../src/world/publication-grants.ts";
import {
	PUBLICATION_INTERACTIONS_SCHEMA,
	PublicationInteractions,
} from "../src/world/publication-interactions.ts";
import { parsePublicationMaterial } from "../src/world/publication-record-validation.ts";
import { parseReplyPublicationPost } from "../src/world/publication-reply-records.ts";
import type {
	EventPublicationPost,
	PublicationPost,
	PublicationPrincipal,
	PublicLifePost,
} from "../src/world/publication-types.ts";
import records from "./fixtures/life-publication-reply-records.json";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
const agent: PublicationPrincipal = { kind: "agent", agentId: "a" };
const absent = [
	{ reactionId: "heart", active: false },
	{ reactionId: "support", active: false },
];
const active = [
	{ reactionId: "heart", active: true },
	{ reactionId: "support", active: false },
];

function transaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}

/** Real interaction/grant SQL with typed content and current-visibility read ports. */
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "lina-reaction-feed-"));
	const path = join(directory, "world.sqlite");
	let db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys=ON");
	db.exec(
		"CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world'),('other')",
	);
	db.exec(PUBLICATION_GRANTS_SCHEMA);
	db.exec(PUBLICATION_INTERACTIONS_SCHEMA);
	const material = parsePublicationMaterial(records.event.material);
	if (material.version !== 1) throw Error("Expected event fixture");
	const root: EventPublicationPost = {
		...records.event.post,
		version: 1,
		material,
		segments: [
			{ kind: "claim", claimKind: "world_event", text: "A bell rang." },
		],
	};
	const generated = parseReplyPublicationPost(records.reply.post);
	const originalGenerated = structuredClone(generated);
	const posts = new Map<string, PublicationPost>([
		[root.id, root],
		[generated.id, generated],
	]);
	const policy = {
		revision: 1,
		recipientIds: ["friends", "others"],
		agents: [{ agentId: "a", recipientId: "friends" }],
		reactionIds: ["heart", "support"],
	};
	const denied = new Set<string>();
	const reactionReads: string[] = [];
	let grants: PublicationGrants;
	let interactions: PublicationInteractions;
	let feed: PublicationFeed;
	function makeFeed(withReactions = true): PublicationFeed {
		return new PublicationFeed(
			{
				get: (world, id) =>
					world === "world" ? (posts.get(id) ?? null) : null,
				list: (world) => (world === "world" ? [...posts.values()] : []),
			},
			grants,
			{
				recipients: (world) => (world === "world" ? policy : null),
				material: (value) => (denied.has(value.id) ? null : value),
				...(withReactions
					? {
							reactions: (
								world: string,
								principal: PublicationPrincipal,
								id: string,
							) => {
								reactionReads.push(id);
								return interactions.reactionState(
									world,
									principal,
									id,
									policy.reactionIds,
								);
							},
						}
					: {}),
			},
			{ posts: { get: () => null, list: () => [] }, interactions },
		);
	}
	function connect() {
		grants = new PublicationGrants(db, () => ({
			settingsRevision: policy.revision,
			recipientIds: policy.recipientIds,
		}));
		interactions = new PublicationInteractions(db, {
			parent: (...args) => feed.parent(...args),
			generated: (_world, job, post) =>
				job === originalGenerated.jobId && post === originalGenerated.id
					? originalGenerated
					: null,
			agents: () => [],
			lifeRevision: () => 7,
			settingsRevision: () => policy.revision,
			now: () => 100,
			reactionAllowed: (_world, id) => policy.reactionIds.includes(id),
			charge: () => false,
			input: () => null,
			admit: () => {
				throw Error("No observing agents configured");
			},
			createPost: () => {
				throw Error("Reaction must not create a post");
			},
		});
		feed = makeFeed();
	}
	connect();
	function mint(requestKey: string) {
		const { grant } = transaction(db, () =>
			grants.mint("world", {
				requestKey,
				expectedSettingsRevision: 1,
				recipientId: "friends",
			}),
		);
		return { kind: "viewer" as const, grantId: grant.id };
	}
	const viewer = mint("one"),
		peer = mint("two");
	cleanup.push(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		root,
		generated,
		viewer,
		peer,
		policy,
		denied,
		reactionReads,
		makeFeed,
		get db() {
			return db;
		},
		get feed() {
			return feed;
		},
		get interactions() {
			return interactions;
		},
		react(
			value: boolean,
			requestKey: string,
			principal: PublicationPrincipal = viewer,
			postId = root.id,
		) {
			return transaction(db, () =>
				interactions.react("world", principal, postId, {
					requestKey,
					expectedPostRevision: 1,
					reactionId: "heart",
					active: value,
				}),
			);
		},
		revoke() {
			transaction(db, () =>
				grants.revoke("world", viewer.grantId, {
					requestKey: "revoke",
					expectedRevision: 1,
				}),
			);
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			connect();
			interactions.validate();
		},
		snapshot() {
			return db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all()
				.map((row) => [
					row["name"],
					db.prepare(`SELECT * FROM ${row["name"]} ORDER BY rowid`).all(),
				]);
		},
	};
}

test("legacy content stays byte-identical and low-level feeds default to an empty reaction view", () => {
	const f = fixture(),
		feed = f.makeFeed(false);
	const bare: PublicLifePost = {
		id: f.root.id,
		revision: 1,
		kind: "post",
		author: { kind: "agent", agentId: "a", name: "A" },
		segments: [
			{ kind: "claim", claimKind: "world_event", text: "A bell rang." },
		],
		createdAt: f.root.createdAt,
	};
	expect(JSON.stringify(feed.content("world", f.viewer, f.root.id))).toBe(
		JSON.stringify(bare),
	);
	expect(feed.post("world", f.viewer, f.root.id)).toEqual({
		...bare,
		reactions: [],
	});
	expect(
		feed
			.query("world", f.viewer, { limit: 100, after: null })
			.items.every((post) => post.reactions.length === 0),
	).toBe(true);
	expect(f.reactionReads).toEqual([]);
});

test("reader reaction state survives add, equal-state requests, remove, replay and SQLite reopen", () => {
	const f = fixture();
	const content = canonicalLifeJson(
		f.feed.content("world", f.viewer, f.root.id),
	);
	expect(f.feed.post("world", f.viewer, f.root.id)?.reactions).toEqual(absent);
	expect(f.react(false, "initial-remove").effective).toBe(false);
	expect(f.react(true, "add").effective).toBe(true);
	expect(f.react(true, "same-state").effective).toBe(false);
	f.reopen();
	expect(f.feed.post("world", f.viewer, f.root.id)?.reactions).toEqual(active);
	expect(f.feed.post("world", f.peer, f.root.id)?.reactions).toEqual(absent);
	expect(f.feed.post("world", agent, f.root.id)?.reactions).toEqual(absent);
	f.react(true, "add", f.peer);
	f.react(true, "add", agent);
	f.react(false, "remove");
	expect(f.react(true, "add").replayed).toBe(true);
	expect(f.react(true, "same-state").effective).toBe(false);
	f.reopen();
	const before = f.snapshot();
	expect(f.feed.post("world", f.viewer, f.root.id)?.reactions).toEqual(absent);
	expect(f.feed.post("world", f.peer, f.root.id)?.reactions).toEqual(active);
	expect(f.feed.post("world", agent, f.root.id)?.reactions).toEqual(active);
	const page = f.feed.query("world", f.viewer, { limit: 100, after: null });
	expect(page.items.find((post) => post.id === f.root.id)?.reactions).toEqual(
		absent,
	);
	expect(
		f.interactions.reactionState("other", f.peer, f.root.id, ["heart"]),
	).toEqual([{ reactionId: "heart", active: false }]);
	expect(canonicalLifeJson(f.feed.content("world", f.viewer, f.root.id))).toBe(
		content,
	);
	expect(f.snapshot()).toEqual(before);
	for (const hidden of [
		f.viewer.grantId,
		f.peer.grantId,
		"principalDigest",
		"interactionId",
		"count",
		"roots",
		"audience",
	])
		expect(JSON.stringify(page)).not.toContain(hidden);
});

test("cursors track only the reader's visible reaction state, including posts beyond the current page", () => {
	const f = fixture();
	const page = () => f.feed.query("world", f.viewer, { limit: 1, after: null });
	const first = page();
	expect(first.nextCursor).not.toBeNull();
	expect(first.items[0]?.id).toBe(f.generated.id);
	f.react(true, "peer-add", f.peer);
	expect(page().nextCursor).toBe(first.nextCursor);
	f.react(true, "own-add");
	expect(() =>
		f.feed.query("world", f.viewer, { limit: 1, after: first.nextCursor }),
	).toThrow("cursor scope changed");
	const added = page();
	f.react(true, "noop");
	expect(page().nextCursor).toBe(added.nextCursor);
	expect(
		f.feed.query("world", f.viewer, { limit: 1, after: added.nextCursor })
			.items[0]?.reactions,
	).toEqual(active);
	f.react(false, "remove");
	expect(() =>
		f.feed.query("world", f.viewer, { limit: 1, after: added.nextCursor }),
	).toThrow("cursor scope changed");
	f.reopen();
	expect(page().nextCursor).toBe(first.nextCursor);
	f.policy.reactionIds = ["support"];
	expect(f.feed.post("world", f.peer, f.root.id)?.reactions).toEqual([
		{ reactionId: "support", active: false },
	]);
	expect(page().nextCursor).not.toBe(first.nextCursor);
});

test("revocation and current ancestor visibility reject before any reaction lookup", () => {
	const f = fixture();
	f.react(true, "add");
	f.reactionReads.length = 0;
	f.denied.add(f.root.material.id);
	expect(f.feed.post("world", f.viewer, f.generated.id)).toBeNull();
	expect(
		f.feed.query("world", f.viewer, { limit: 100, after: null }).items,
	).toEqual([]);
	expect(f.reactionReads).toEqual([]);
	f.denied.clear();
	f.root.material.audience = ["others"];
	expect(f.feed.post("world", f.viewer, f.root.id)).toBeNull();
	expect(f.feed.post("world", f.viewer, "missing")).toBeNull();
	expect(f.reactionReads).toEqual([]);
	f.root.material.audience = ["friends"];
	f.revoke();
	f.reopen();
	expect(() => f.feed.post("world", f.viewer, f.root.id)).toThrow("forbidden");
	expect(() =>
		f.feed.query("world", f.viewer, { limit: 100, after: null }),
	).toThrow("forbidden");
	expect(() => f.feed.content("world", f.viewer, f.root.id)).toThrow(
		"forbidden",
	);
	expect(f.reactionReads).toEqual([]);
	expect(f.feed.post("world", f.peer, f.root.id)?.reactions).toEqual(absent);
});

test("current views preserve generated v2 receipt history and immutable parent material", () => {
	const f = fixture();
	transaction(f.db, () =>
		f.interactions.generatedReply("world", f.generated.jobId, f.generated.id),
	);
	const frozen = canonicalLifeJson(f.generated.material);
	const receipt = () =>
		f.db
			.prepare(
				"SELECT * FROM life_publication_interaction_receipts WHERE sequence=1",
			)
			.get();
	const originalReceipt = receipt();
	f.react(true, "parent", agent);
	f.react(true, "child", f.viewer, f.generated.id);
	f.reopen();
	const before = f.snapshot();
	expect(f.feed.post("world", f.viewer, f.generated.id)?.reactions).toEqual(
		active,
	);
	expect(f.feed.post("world", agent, f.generated.id)?.reactions).toEqual(
		absent,
	);
	expect(f.feed.content("world", agent, f.root.id)).not.toHaveProperty(
		"reactions",
	);
	expect(canonicalLifeJson(f.generated.material)).toBe(frozen);
	expect(receipt()).toEqual(originalReceipt);
	expect(f.snapshot()).toEqual(before);
});

test.each([
	"UPDATE life_publication_reaction_heads SET active=0",
	"DELETE FROM life_publication_reaction_heads",
	"UPDATE life_publication_interaction_receipts SET digest='invalid'",
])("reaction reads fail closed on corrupt durable history: %s", (sql) => {
	const f = fixture();
	f.react(true, "add");
	f.db.exec(sql);
	const before = f.snapshot();
	expect(() => f.feed.post("world", f.viewer, f.root.id)).toThrow();
	expect(f.snapshot()).toEqual(before);
});
