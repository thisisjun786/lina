import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import {
	PUBLICATION_INTERACTIONS_SCHEMA,
	type PublicationInteraction,
	PublicationInteractions,
} from "../src/world/publication-interactions.ts";
import {
	PUBLICATION_REPLY_POSTS_SCHEMA,
	type PublicationReplyPost,
	PublicationReplyPosts,
} from "../src/world/publication-reply-posts.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
const tables = [
	"life_publication_reply_posts",
	"life_publication_reply_post_history",
	"life_publication_reply_post_receipts",
	"life_publication_reply_post_requests",
] as const;
const withdrawal = { requestKey: "withdraw", expectedRevision: 1 };
function interaction(
	overrides: Partial<PublicationInteraction> = {},
): PublicationInteraction {
	return {
		version: 1,
		worldId: "world",
		id: "interaction",
		requestKey: "reply-key",
		principal: { kind: "viewer", grantId: "grant" },
		parentPostId: "parent",
		expectedPostRevision: 3,
		action: { kind: "reply", text: "Hello" },
		roots: [
			{ rootId: "root-a", depth: 1 },
			{ rootId: "root-b", depth: 3 },
		],
		audience: ["recipient-a", "recipient-b"],
		createdAt: 100,
		lifeRevision: 0,
		settingsRevision: 1,
		postId: "stable-post",
		processing: "queued",
		observationIds: ["observation-b", "observation-a"],
		...overrides,
	};
}
const expectedPost: PublicationReplyPost = {
	version: 1,
	worldId: "world",
	id: "stable-post",
	revision: 1,
	interactionId: "interaction",
	parentPostId: "parent",
	principal: { kind: "viewer", grantId: "grant" },
	audience: ["recipient-a", "recipient-b"],
	roots: [
		{ rootId: "root-a", depth: 1 },
		{ rootId: "root-b", depth: 3 },
	],
	createdAt: 100,
	createdLifeRevision: 0,
	withdrawn: false,
};
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
/** Durable source seam; the main WorldStore integrates the complete interaction owner. */
function fixture() {
	const directory = mkdtempSync(
		join(tmpdir(), "lina-publication-reply-posts-"),
	);
	const path = join(directory, "world.sqlite");
	let db = new DatabaseSync(path),
		sourceReads = 0,
		sourceAvailable = true;
	db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
	db.exec(`CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT;
		INSERT INTO worlds VALUES('world'),('other');
		CREATE TABLE fixture_interactions(world_id TEXT, interaction_id TEXT, interaction_json TEXT,
		 PRIMARY KEY(world_id,interaction_id)) STRICT;`);
	db.exec(PUBLICATION_REPLY_POSTS_SCHEMA);
	function access(connection: DatabaseSync) {
		return {
			interaction(worldId: string, id: string): PublicationInteraction {
				sourceReads++;
				if (!sourceAvailable)
					throw Error("Observation insertion has not finished");
				const row = connection
					.prepare(
						"SELECT interaction_json FROM fixture_interactions WHERE world_id=? AND interaction_id=?",
					)
					.get(worldId, id);
				if (!row) throw Error("Missing original interaction");
				return JSON.parse(String(row["interaction_json"]));
			},
		};
	}
	let owner = new PublicationReplyPosts(db, access(db));
	cleanup.push(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	function saveSource(value: PublicationInteraction) {
		db.prepare("INSERT INTO fixture_interactions VALUES(?,?,?)").run(
			value.worldId,
			value.id,
			canonicalLifeJson(value),
		);
	}
	return {
		path,
		access,
		saveSource,
		get db() {
			return db;
		},
		get owner() {
			return owner;
		},
		get sourceReads() {
			return sourceReads;
		},
		set sourceAvailable(value: boolean) {
			sourceAvailable = value;
		},
		create(value = interaction()) {
			return transaction(db, () => {
				const post = owner.create(value);
				saveSource(value);
				return post;
			});
		},
		withdraw(input = withdrawal, postId = "stable-post", worldId = "world") {
			return transaction(db, () => owner.withdraw(worldId, postId, input));
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			owner = new PublicationReplyPosts(db, access(db));
			owner.validate();
		},
		snapshot() {
			return [...tables, "fixture_interactions"].map((table) => {
				const statement = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`);
				// Preserve corrupt SQL integers exactly; normal owner reads must still reject them.
				statement.setReadBigInts(true);
				return statement.all();
			});
		},
	};
}

test("create and create replay never look up the interaction while its observations are incomplete", () => {
	const f = fixture();
	f.sourceAvailable = false;
	const source = interaction(),
		original = canonicalLifeJson(source);
	expect(f.create(source)).toEqual(expectedPost);
	expect(transaction(f.db, () => f.owner.create(source))).toEqual(expectedPost);
	expect(f.sourceReads).toBe(0);
	expect(canonicalLifeJson(source)).toBe(original);
	f.sourceAvailable = true;
	expect(f.owner.get("world", "stable-post")).toEqual(expectedPost);
	const before = f.snapshot();
	f.reopen();
	expect(f.owner.list("world")).toEqual([expectedPost]);
	expect(f.owner.get("other", "stable-post")).toBeNull();
	expect(f.owner.get("world", "missing")).toBeNull();
	expect(f.owner.list("other")).toEqual([]);
	expect(f.snapshot()).toEqual(before);
});

test("stopped reshares retain the exact supplied stable identity and original metadata", () => {
	const f = fixture();
	const source = interaction({
		action: { kind: "reshare" },
		processing: "stopped",
		observationIds: [],
		principal: { kind: "agent", agentId: "alice" },
		lifeRevision: 9,
	});
	expect(f.create(source)).toEqual({
		...expectedPost,
		principal: { kind: "agent", agentId: "alice" },
		createdLifeRevision: 9,
	});
	f.reopen();
});

test("withdrawal retains a single tombstone, timestamp and original, with exact idempotent receipts", () => {
	const f = fixture();
	f.create();
	const tombstone = { ...expectedPost, revision: 2, withdrawn: true };
	expect(f.withdraw()).toEqual(tombstone);
	const before = f.snapshot();
	expect(f.withdraw()).toEqual(tombstone);
	expect(f.snapshot()).toEqual(before);
	expect(f.withdraw({ requestKey: "already", expectedRevision: 2 })).toEqual(
		tombstone,
	);
	expect(
		f.db
			.prepare("SELECT count(*) AS n FROM life_publication_reply_post_history")
			.get()?.["n"],
	).toBe(2);
	f.reopen();
	expect(transaction(f.db, () => f.owner.create(interaction()))).toEqual(
		tombstone,
	);
	expect(f.withdraw()).toEqual(tombstone);
	expect(f.owner.get("world", "stable-post")).toEqual(tombstone);
});

test("withdrawal keys bind exact payload and post within their world; conflicts never write", () => {
	const f = fixture();
	f.create();
	f.create(interaction({ id: "second", postId: "second-post" }));
	f.create(interaction({ worldId: "other" }));
	f.withdraw();
	const before = f.snapshot();
	for (const invoke of [
		() => f.withdraw({ ...withdrawal, expectedRevision: 2 }),
		() => f.withdraw(withdrawal, "second-post"),
		() => f.withdraw({ requestKey: "stale", expectedRevision: 1 }),
		() => f.withdraw(withdrawal, "missing"),
		() =>
			transaction(f.db, () =>
				f.owner.create(interaction({ audience: ["outsider"] })),
			),
		() =>
			transaction(f.db, () =>
				f.owner.create(
					interaction({ action: { kind: "reply", text: "changed" } }),
				),
			),
		() =>
			transaction(f.db, () =>
				f.owner.create(interaction({ action: { kind: "reshare" } })),
			),
	])
		expect(invoke).toThrow();
	expect(f.snapshot()).toEqual(before);
	expect(f.withdraw(withdrawal, "stable-post", "other").withdrawn).toBe(true);
	f.reopen();
});

test("caller rollback removes both completed creation and completed withdrawal", () => {
	const f = fixture();
	const empty = f.snapshot();
	expect(() =>
		transaction(f.db, () => {
			f.owner.create(interaction());
			f.saveSource(interaction());
			throw Error("outer failure");
		}),
	).toThrow();
	expect(f.snapshot()).toEqual(empty);
	f.create();
	const live = f.snapshot();
	expect(() =>
		transaction(f.db, () => {
			f.owner.withdraw("world", "stable-post", withdrawal);
			throw Error("outer failure");
		}),
	).toThrow();
	expect(f.snapshot()).toEqual(live);
	f.reopen();
});

for (const [name, table, operation] of [
	["head write", "life_publication_reply_posts", "create"],
	["creation receipt", "life_publication_reply_post_receipts", "create"],
	["withdrawal receipt", "life_publication_reply_post_requests", "withdraw"],
] as const) {
	test(`caller rolls back partial post history on injected ${name} failure`, () => {
		const f = fixture();
		if (operation === "withdraw") f.create();
		const before = f.snapshot();
		f.db.exec(
			`CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
		);
		expect(() => (operation === "create" ? f.create() : f.withdraw())).toThrow(
			"injected failure",
		);
		expect(f.snapshot()).toEqual(before);
		f.reopen();
	});
}

test("two connections serialize withdrawal and replay the committed receipt", () => {
	const f = fixture();
	f.create();
	const peerDb = new DatabaseSync(f.path);
	cleanup.push(() => peerDb.close());
	peerDb.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
	const peer = new PublicationReplyPosts(peerDb, f.access(peerDb));
	f.db.exec("BEGIN IMMEDIATE");
	const result = f.owner.withdraw("world", "stable-post", withdrawal);
	expect(() => peerDb.exec("BEGIN IMMEDIATE")).toThrow();
	expect(peer.get("world", "stable-post")?.withdrawn).toBe(false);
	f.db.exec("COMMIT");
	expect(
		transaction(peerDb, () =>
			peer.withdraw("world", "stable-post", withdrawal),
		),
	).toEqual(result);
	peer.validate();
	f.reopen();
});

for (const [name, sql] of [
	["missing head", "DELETE FROM life_publication_reply_posts"],
	[
		"missing original history",
		"DELETE FROM life_publication_reply_post_history WHERE revision=1",
	],
	[
		"missing tombstone history",
		"DELETE FROM life_publication_reply_post_history WHERE revision=2",
	],
	[
		"missing creation receipt",
		"DELETE FROM life_publication_reply_post_receipts",
	],
	[
		"missing withdrawal receipt even with a noop receipt",
		"DELETE FROM life_publication_reply_post_requests WHERE expected_revision=1",
	],
	["missing original interaction", "DELETE FROM fixture_interactions"],
	[
		"incorrect result revision",
		"UPDATE life_publication_reply_post_requests SET result_revision=1",
	],
	[
		"wrong withdrawal digest",
		"UPDATE life_publication_reply_post_requests SET payload_digest='bad'",
	],
	[
		"wrong source digest",
		"UPDATE life_publication_reply_post_receipts SET interaction_digest='bad'",
	],
	[
		"wrong original post digest",
		"UPDATE life_publication_reply_post_receipts SET post_digest='bad'",
	],
	[
		"unsafe head revision",
		"UPDATE life_publication_reply_posts SET revision=9007199254740992",
	],
] as const) {
	test(`actual-file reopen rejects ${name}`, () => {
		const f = fixture();
		f.create();
		f.withdraw();
		f.withdraw({ requestKey: "noop", expectedRevision: 2 });
		f.db.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
		f.db.exec(sql);
		const before = f.snapshot();
		expect(() => f.reopen()).toThrow();
		expect(f.snapshot()).toEqual(before);
	});
}

function rehashPosts(
	f: ReturnType<typeof fixture>,
	change: (value: Record<string, unknown>) => void,
) {
	for (const table of [
		"life_publication_reply_posts",
		"life_publication_reply_post_history",
	] as const) {
		for (const row of f.db
			.prepare(`SELECT rowid,post_json FROM ${table}`)
			.all()) {
			const value: Record<string, unknown> = JSON.parse(
				String(row["post_json"]),
			);
			change(value);
			f.db
				.prepare(`UPDATE ${table} SET post_json=?,digest=? WHERE rowid=?`)
				.run(canonicalLifeJson(value), lifeDigest(value), Number(row["rowid"]));
		}
	}
	const original = f.db
		.prepare(
			"SELECT digest FROM life_publication_reply_post_history WHERE revision=1",
		)
		.get();
	f.db
		.prepare("UPDATE life_publication_reply_post_receipts SET post_digest=?")
		.run(String(original?.["digest"]));
}
for (const [name, change] of [
	[
		"foreign principal",
		(p: Record<string, unknown>) => {
			p["principal"] = { kind: "agent", agentId: "fake" };
		},
	],
	[
		"expanded audience",
		(p: Record<string, unknown>) => {
			p["audience"] = ["outsider"];
		},
	],
	[
		"shortened roots",
		(p: Record<string, unknown>) => {
			p["roots"] = [{ rootId: "root-a", depth: 0 }];
		},
	],
	[
		"wrong parent",
		(p: Record<string, unknown>) => {
			p["parentPostId"] = "other-parent";
		},
	],
	[
		"wrong timestamp",
		(p: Record<string, unknown>) => {
			p["createdAt"] = 101;
		},
	],
	[
		"wrong LIFE revision",
		(p: Record<string, unknown>) => {
			p["createdLifeRevision"] = 1;
		},
	],
	[
		"unknown field",
		(p: Record<string, unknown>) => {
			p["hidden"] = true;
		},
	],
	[
		"unknown version",
		(p: Record<string, unknown>) => {
			p["version"] = 2;
		},
	],
	[
		"duplicate roots",
		(p: Record<string, unknown>) => {
			p["roots"] = [
				{ rootId: "root-a", depth: 1 },
				{ rootId: "root-a", depth: 1 },
			];
		},
	],
] as const) {
	test(`rehashed ${name} cannot replace the immutable interaction`, () => {
		const f = fixture();
		f.create();
		f.withdraw();
		rehashPosts(f, change);
		expect(() => f.reopen()).toThrow();
	});
}

test("receipt auditing rejects duplicate effective withdrawals and receipts for a live post", () => {
	const f = fixture();
	f.create();
	f.withdraw();
	const payload = {
		worldId: "world",
		postId: "stable-post",
		requestKey: "forged",
		expectedRevision: 1,
	};
	f.db
		.prepare(`INSERT INTO life_publication_reply_post_requests
		(world_id,request_key,post_id,expected_revision,result_revision,payload_digest) VALUES(?,?,?,?,?,?)`)
		.run(
			payload.worldId,
			payload.requestKey,
			payload.postId,
			1,
			2,
			lifeDigest(payload),
		);
	expect(() => f.reopen()).toThrow();
	const g = fixture();
	g.create();
	g.db.exec("PRAGMA foreign_keys=OFF");
	g.db
		.prepare(`INSERT INTO life_publication_reply_post_requests
		(world_id,request_key,post_id,expected_revision,result_revision,payload_digest) VALUES(?,?,?,?,?,?)`)
		.run(
			payload.worldId,
			payload.requestKey,
			payload.postId,
			1,
			2,
			lifeDigest(payload),
		);
	expect(() => g.reopen()).toThrow();
});

test("get and list reject a receipt without its post and never silently recreate missing history", () => {
	const f = fixture();
	f.create();
	f.db.exec(
		"PRAGMA foreign_keys=OFF; DELETE FROM life_publication_reply_posts",
	);
	expect(() => f.owner.get("world", "stable-post")).toThrow();
	expect(() => f.owner.list("world")).toThrow();
	const before = f.snapshot();
	expect(() =>
		transaction(f.db, () => f.owner.create(interaction())),
	).toThrow();
	expect(f.snapshot()).toEqual(before);
});

test("source action and stable post ID are checked even when the rendered metadata is unchanged", () => {
	for (const change of [
		{ action: { kind: "reshare" } },
		{ action: { kind: "reply", text: "changed" } },
		{ action: { kind: "reaction", reactionId: "heart", active: true } },
		{ postId: "another-post" },
	]) {
		const f = fixture();
		f.create();
		f.db
			.prepare("UPDATE fixture_interactions SET interaction_json=?")
			.run(canonicalLifeJson({ ...interaction(), ...change }));
		expect(() => f.reopen()).toThrow();
	}
});

test("strict caller shapes, IDs, bounds and reaction exclusions fail before any writes", () => {
	const f = fixture();
	const before = f.snapshot();
	let getters = 0;
	const cases: unknown[] = [
		{ ...interaction(), extra: true },
		{ ...interaction(), version: 9 },
		interaction({ postId: null }),
		interaction({ postId: "../post" }),
		interaction({
			action: { kind: "reaction", reactionId: "heart", active: true },
		}),
		interaction({ createdAt: Number.NaN }),
		interaction({ lifeRevision: -1 }),
		interaction({ createdAt: Number.MAX_SAFE_INTEGER + 1 }),
		interaction({ audience: [] }),
		interaction({ audience: ["same", "same"] }),
		interaction({ roots: [] }),
		interaction({ observationIds: ["same", "same"] }),
		{
			...interaction(),
			get principal() {
				getters++;
				return { kind: "viewer", grantId: "grant" };
			},
		},
	];
	// Deliberately cross the typed boundary with invalid runtime input to test parsing.
	for (const value of cases)
		expect(() =>
			transaction(f.db, () => f.owner.create(value as PublicationInteraction)),
		).toThrow();
	expect(getters).toBe(0);
	expect(f.snapshot()).toEqual(before);
	expect(() => f.owner.create(interaction())).toThrow("transaction");
	f.create();
	const created = f.snapshot();
	for (const value of [
		{ ...withdrawal, unknown: true },
		{ ...withdrawal, expectedRevision: 0 },
		{ ...withdrawal, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...withdrawal, requestKey: "../key" },
	])
		expect(() => f.withdraw(value)).toThrow();
	expect(f.snapshot()).toEqual(created);
	expect(() => f.owner.withdraw("world", "stable-post", withdrawal)).toThrow(
		"transaction",
	);
});

test("the real interaction callback creates a post before observation insertion and audits after revocation", () => {
	const f = fixture();
	f.db.exec(PUBLICATION_INTERACTIONS_SCHEMA);
	f.db.exec(
		"CREATE TABLE fixture_inputs(world_id TEXT,input_id TEXT,input_json TEXT,PRIMARY KEY(world_id,input_id)) STRICT",
	);
	let sourceReads = 0,
		parentReads = 0,
		visible = true;
	const posts = new PublicationReplyPosts(f.db, {
		interaction(worldId, id) {
			sourceReads++;
			return interactions.get(worldId, id);
		},
	});
	const interactions = new PublicationInteractions(f.db, {
		parent(_world, _principal, id) {
			parentReads++;
			return visible && id === "parent"
				? {
						id,
						revision: 1,
						audience: ["recipient"],
						roots: [{ rootId: "root", depth: 0 }],
					}
				: null;
		},
		agents: () => ["alice"],
		lifeRevision: () => 4,
		settingsRevision: () => 1,
		now: () => 100,
		reactionAllowed: () => true,
		charge: () => true,
		createPost(source) {
			expect(
				f.db
					.prepare("SELECT count(*) AS n FROM life_publication_observations")
					.get()?.["n"],
			).toBe(0);
			posts.create(source);
			expect(sourceReads).toBe(0);
		},
		admit(input) {
			f.db
				.prepare("INSERT INTO fixture_inputs VALUES(?,?,?)")
				.run(input.worldId, input.id, canonicalLifeJson(input));
			return {
				worldId: input.worldId,
				inputId: input.id,
				payloadDigest: input.payloadDigest,
				replayed: false,
			};
		},
		input(worldId, id) {
			const row = f.db
				.prepare(
					"SELECT input_json FROM fixture_inputs WHERE world_id=? AND input_id=?",
				)
				.get(worldId, id);
			return row ? parseLifeInput(JSON.parse(String(row["input_json"]))) : null;
		},
	});
	const result = transaction(f.db, () =>
		interactions.reply(
			"world",
			{ kind: "viewer", grantId: "grant" },
			"parent",
			{ requestKey: "reply", expectedPostRevision: 1, text: "Hello" },
		),
	);
	if (!result.postId || !result.interaction)
		throw Error("Expected an effective reply");
	const postId = result.postId;
	expect(posts.get("world", result.postId)).toMatchObject({
		id: result.postId,
		interactionId: result.interaction.id,
		roots: [{ rootId: "root", depth: 1 }],
		createdLifeRevision: 4,
		withdrawn: false,
	});
	expect(interactions.observations("world")).toHaveLength(1);
	visible = false;
	const readsBefore = parentReads;
	expect(() => posts.validate()).not.toThrow();
	expect(parentReads).toBe(readsBefore);
	const withdrawn = transaction(f.db, () =>
		posts.withdraw("world", postId, withdrawal),
	);
	expect(withdrawn.withdrawn).toBe(true);
	expect(() => posts.validate()).not.toThrow();
});

test("maximum safe timestamps and LIFE revisions and maximum identifier length survive reopen", () => {
	const f = fixture();
	const source = interaction({
		id: "i".repeat(128),
		postId: "p".repeat(128),
		createdAt: Number.MAX_SAFE_INTEGER,
		lifeRevision: Number.MAX_SAFE_INTEGER,
	});
	const post = f.create(source);
	expect(post.id).toBe("p".repeat(128));
	expect(post.createdAt).toBe(Number.MAX_SAFE_INTEGER);
	f.reopen();
	expect(f.owner.get("world", post.id)).toEqual(post);
});
