import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import {
	PUBLICATION_CHAINS_SCHEMA,
	PublicationChains,
} from "../src/world/publication-chains.ts";
import {
	parsePublicationAction,
	parsePublicationAuthority,
	publicationObservationId,
} from "../src/world/publication-input.ts";
import {
	type Access,
	PUBLICATION_INTERACTIONS_SCHEMA,
	PublicationInteractions,
} from "../src/world/publication-interactions.ts";
import {
	PUBLICATION_JOBS_SCHEMA,
	PublicationJobs,
} from "../src/world/publication-jobs.ts";
import {
	PUBLICATION_POSTS_SCHEMA,
	PublicationPosts,
} from "../src/world/publication-posts.ts";
import {
	parsePublicationJob,
	parsePublicationMaterial,
} from "../src/world/publication-record-validation.ts";
import type {
	PublicationDecision,
	PublicationPost,
	ReplyPublicationPost,
} from "../src/world/publication-types.ts";
import records from "./fixtures/life-publication-reply-records.json";
import { publicationStoreFixture } from "./life-publication-store-fixture.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
const limits = {
	maxChainDepth: 8,
	maxActionsPerChain: 20,
	perAuthorCooldownSteps: 2,
};
const parent = {
	id: records.event.post.id,
	revision: 1,
	audience: ["friends"],
	roots: [{ rootId: "root-a", depth: 0 }],
};

/** Real post/job/chain owners; only current visibility and LIFE admission are SQL seams. */
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "lina-generated-interactions-"));
	const path = join(directory, "world.sqlite");
	let db = new DatabaseSync(path);
	db.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT; INSERT INTO worlds VALUES('world'); CREATE TABLE fixture_inputs(world_id TEXT,input_id TEXT,input_json TEXT,PRIMARY KEY(world_id,input_id)) STRICT;",
	);
	for (const schema of [
		PUBLICATION_JOBS_SCHEMA,
		PUBLICATION_POSTS_SCHEMA,
		PUBLICATION_CHAINS_SCHEMA,
		PUBLICATION_INTERACTIONS_SCHEMA,
	])
		db.exec(schema);
	let enabled = true,
		visible = true,
		recipients = ["b", "a", "a", "c"],
		ordinaryCalls = 0;
	let fault: ((post: ReplyPublicationPost) => ReplyPublicationPost) | null =
		null;
	function owners() {
		const jobs = new PublicationJobs(db),
			posts = new PublicationPosts(db, jobs),
			chains = new PublicationChains(db);
		const access: Access = {
			parent: (_world, _principal, id) =>
				visible && id === parent.id ? parent : null,
			agents: () => recipients,
			lifeRevision: () => 9,
			settingsRevision: () => 1,
			now: () => 200,
			reactionAllowed: () => true,
			charge: () => {
				ordinaryCalls++;
				return true;
			},
			createPost: () => {
				ordinaryCalls++;
			},
			generated(worldId, jobId, postId, historical) {
				if (!enabled || (!historical && !visible)) return null;
				const head = posts.get(worldId, postId);
				if (head?.version !== 2 || (!historical && head.withdrawn)) return null;
				const post = posts.at(worldId, postId, 1);
				const job = jobs.get(worldId, jobId);
				if (
					post.version !== 2 ||
					post.jobId !== job.id ||
					job.version !== 2 ||
					job.attemptId !== post.attemptId ||
					!["ready", "published"].includes(job.status) ||
					(job.status === "published" && job.postId !== post.id)
				)
					throw Error("Generated owner mismatch");
				if (
					!chains.hasCharge(
						worldId,
						`publication-${job.id}`,
						post.roots,
						`actor-${lifeDigest({ kind: "agent", agentId: post.author.agentId })}`,
						post.createdLifeRevision,
						limits,
						true,
					)
				)
					throw Error("Missing generated publication charge");
				return fault ? fault(post) : post;
			},
			admit(input) {
				parseLifeInput(input);
				db.prepare("INSERT INTO fixture_inputs VALUES(?,?,?)").run(
					input.worldId,
					input.id,
					canonicalLifeJson(input),
				);
				return {
					worldId: input.worldId,
					inputId: input.id,
					payloadDigest: input.payloadDigest,
					replayed: false,
				};
			},
			input(world, id) {
				const row = db
					.prepare(
						"SELECT input_json FROM fixture_inputs WHERE world_id=? AND input_id=?",
					)
					.get(world, id);
				return row
					? parseLifeInput(JSON.parse(String(row["input_json"])))
					: null;
			},
		};
		return {
			jobs,
			posts,
			chains,
			access,
			interactions: new PublicationInteractions(db, access),
		};
	}
	let current = owners();
	cleanup.push(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	function transaction<T>(action: () => T): T {
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
	return {
		get db() {
			return db;
		},
		get current() {
			return current;
		},
		get ordinaryCalls() {
			return ordinaryCalls;
		},
		set enabled(value: boolean) {
			enabled = value;
		},
		set visible(value: boolean) {
			visible = value;
		},
		set recipients(value: string[]) {
			recipients = value;
		},
		set fault(value: typeof fault) {
			fault = value;
		},
		transaction,
		seed(decision = parsePublicationJob(records.reply.job).decision) {
			if (!decision) throw Error("Missing fixture decision");
			const job = current.jobs.discoverReply(
				"world",
				parent.id,
				"b",
				"friends",
			);
			current.jobs.freeze(
				"world",
				job.id,
				parsePublicationMaterial(records.reply.material),
				records.reply.job.author,
				1,
			);
			return current.jobs.ready("world", job.id, decision);
		},
		publish(charge = true): PublicationPost {
			if (!db.isTransaction) return transaction(() => this.publish(charge));
			const job = current.jobs.get("world", records.reply.job.id);
			const post = current.posts.publish(job, 200, 9, records.reply.post.roots);
			if (charge)
				current.chains.charge(
					"world",
					`publication-${job.id}`,
					post.roots,
					`actor-${lifeDigest({ kind: "agent", agentId: "b" })}`,
					9,
					limits,
					true,
				);
			return post;
		},
		deliver() {
			return transaction(() =>
				current.interactions.generatedReply(
					"world",
					records.reply.job.id,
					records.reply.post.id,
				),
			);
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			current = owners();
			current.interactions.validate();
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

test("generated delivery reuses its paid post, targets the child and replays one receipt across reopen", () => {
	const f = fixture();
	f.seed();
	const post = f.publish();
	const result = f.deliver();
	expect(result.interaction).toMatchObject({
		version: 2,
		principal: { kind: "agent", agentId: "b" },
		parentPostId: parent.id,
		postId: post.id,
		roots: [{ rootId: "root-a", depth: 1 }],
		processing: "queued",
		action: { kind: "generated_reply", segments: post.segments },
		generated: {
			jobId: post.jobId,
			attemptId: post.attemptId,
			postRevision: 1,
			chargeKey: `publication-${post.jobId}`,
		},
	});
	const frontier = f.current.interactions.observationSnapshot("world");
	expect(frontier.revision).toBe(1);
	expect(frontier.records.map((row) => row.source.recipientAgentId)).toEqual([
		"a",
		"c",
	]);
	for (const row of frontier.records)
		expect(row.source).toMatchObject({
			postId: post.id,
			postRevision: 1,
			action: { kind: "generated_reply", segments: post.segments },
		});
	const before = f.snapshot();
	expect(f.deliver()).toEqual({ ...result, replayed: true });
	f.reopen();
	expect(f.deliver()).toEqual({ ...result, replayed: true });
	expect(f.snapshot()).toEqual(before);
	expect(f.ordinaryCalls).toBe(0);
	expect(f.current.chains.snapshot("world").revision).toBe(1);
	f.transaction(() =>
		f.current.interactions.reply(
			"world",
			{ kind: "viewer", grantId: "reader" },
			parent.id,
			{ requestKey: "legacy", expectedPostRevision: 1, text: "A user reply" },
		),
	);
	f.reopen();
	expect(f.current.interactions.observationSnapshot("world", 1)).toEqual(
		frontier,
	);
});

test("generated observation callbacks are mandatory for admission and historical recovery", () => {
	const f = fixture();
	f.seed();
	f.publish();
	const { generated: _generated, ...ordinary } = f.current.access;
	const absent = new PublicationInteractions(f.db, ordinary);
	expect(() =>
		f.transaction(() =>
			absent.generatedReply(
				"world",
				records.reply.job.id,
				records.reply.post.id,
			),
		),
	).toThrow("generated");
	f.enabled = false;
	expect(() => f.deliver()).toThrow();
	f.enabled = true;
	f.deliver();
	expect(() => absent.validate()).toThrow("generated");
	f.enabled = false;
	expect(() => f.reopen()).toThrow();
});

test("missing paid activity fails before admission and rolls back the generated post", () => {
	const f = fixture();
	f.seed();
	const before = f.snapshot();
	expect(() =>
		f.transaction(() => {
			f.publish(false);
			f.current.interactions.generatedReply(
				"world",
				records.reply.job.id,
				records.reply.post.id,
			);
		}),
	).toThrow("charge");
	expect(f.snapshot()).toEqual(before);
});

test("original generated history opens after child withdrawal, while fresh delivery is denied", () => {
	const f = fixture();
	f.seed();
	f.publish();
	f.deliver();
	const snapshot = f.current.interactions.observationSnapshot("world");
	f.current.posts.withdraw("world", records.reply.post.id, {
		requestKey: "withdraw",
		expectedRevision: 1,
	});
	expect(() => f.deliver()).toThrow();
	f.reopen();
	expect(f.current.interactions.observationSnapshot("world")).toEqual(snapshot);
});

test("zero eligible observers remains charged and queued without sender feedback", () => {
	const f = fixture();
	f.seed();
	f.publish();
	f.recipients = ["b"];
	expect(f.deliver().interaction).toMatchObject({
		processing: "queued",
		observationIds: [],
	});
	f.reopen();
	expect(f.current.interactions.observations("world")).toEqual([]);
	expect(f.current.chains.snapshot("world").revision).toBe(1);
});

test.each(["world", "job", "attempt", "author", "roots", "text"])(
	"reopen rejects changed generated %s owner metadata",
	(field) => {
		const f = fixture();
		f.seed();
		f.publish();
		f.deliver();
		f.fault = (post) => {
			switch (field) {
				case "world":
					return { ...post, worldId: "other" };
				case "job":
					return { ...post, jobId: "other" };
				case "attempt":
					return { ...post, attemptId: "other" };
				case "author":
					return { ...post, author: { ...post.author, agentId: "other" } };
				case "roots":
					return { ...post, roots: [{ rootId: "root-a", depth: 0 }] };
				default:
					return {
						...post,
						segments: [{ kind: "imaginative", text: "changed" }],
					};
			}
		};
		expect(() => f.reopen()).toThrow();
	},
);

test("aggregate generated experience overflow rolls back post, charge and observations without truncating", () => {
	const f = fixture();
	const decision: PublicationDecision = {
		kind: "post",
		segments: [
			{ kind: "imaginative", text: "x".repeat(16_384) },
			{ kind: "imaginative", text: "y".repeat(16_384) },
		],
	};
	f.seed(decision);
	const before = f.snapshot();
	expect(() =>
		f.transaction(() => {
			f.publish();
			f.current.interactions.generatedReply(
				"world",
				records.reply.job.id,
				records.reply.post.id,
			);
		}),
	).toThrow();
	expect(f.snapshot()).toEqual(before);
	f.reopen();
});

test("ordinary endpoint bodies reject generated-action smuggling without writes", () => {
	const f = fixture();
	const before = f.snapshot();
	const body = {
		requestKey: "forged",
		expectedPostRevision: 1,
		text: "fake",
		action: { kind: "generated_reply", segments: records.reply.post.segments },
	};
	expect(() =>
		f.transaction(() =>
			f.current.interactions.reply(
				"world",
				{ kind: "agent", agentId: "b" },
				parent.id,
				body,
			),
		),
	).toThrow();
	expect(() =>
		f.transaction(() =>
			f.current.interactions.reshare(
				"world",
				{ kind: "agent", agentId: "b" },
				parent.id,
				body,
			),
		),
	).toThrow();
	expect(() =>
		f.transaction(() =>
			f.current.interactions.react(
				"world",
				{ kind: "agent", agentId: "b" },
				parent.id,
				{ ...body, reactionId: "heart", active: true },
			),
		),
	).toThrow();
	expect(f.snapshot()).toEqual(before);
});

test("generated action codec strictly preserves claim tags and bounds labels plus separators", () => {
	const action = {
		kind: "generated_reply",
		segments: records.reply.post.segments,
	};
	expect<unknown>(parsePublicationAction(action)).toEqual(action);
	for (const segments of [
		[],
		[{ kind: "user_authored", text: "fake" }],
		[{ kind: "claim", text: "missing type" }],
		[{ kind: "claim", claimKind: "life_claim", text: "x", claimId: "hidden" }],
		[{ kind: "imaginative", text: "x".repeat(32_768) }],
	])
		expect(() => parsePublicationAction({ ...action, segments })).toThrow();
	const text = "x".repeat(32_768 - "[imaginative] ".length);
	expect(
		parsePublicationAction({
			kind: "generated_reply",
			segments: [{ kind: "imaginative", text }],
		}),
	).toEqual({
		kind: "generated_reply",
		segments: [{ kind: "imaginative", text }],
	});
});

test("v1 receipt, interaction, input, source and authority bytes retain independent golden digests across mixed-history reopen", () => {
	const f = fixture();
	const legacy = f.transaction(() =>
		f.current.interactions.reply(
			"world",
			{ kind: "viewer", grantId: "reader" },
			parent.id,
			{
				requestKey: "legacy-v1",
				expectedPostRevision: 1,
				text: "Legacy reply.",
			},
		),
	);
	if (!legacy.interaction) throw Error("Missing legacy fixture interaction");
	const receiptRow = f.db
		.prepare("SELECT receipt_json FROM life_publication_interaction_receipts")
		.get();
	const interactionRow = f.db
		.prepare("SELECT interaction_json FROM life_publication_interactions")
		.get();
	const observationRow = f.db
		.prepare(
			"SELECT input_json FROM life_publication_observations WHERE agent_id='a'",
		)
		.get();
	const bytes = [
		String(receiptRow?.["receipt_json"]),
		String(interactionRow?.["interaction_json"]),
		String(observationRow?.["input_json"]),
	];
	// Expected digests were calculated independently with Python hashlib over the v1 contract.
	expect(
		bytes.map((json) => createHash("sha256").update(json).digest("hex")),
	).toEqual([
		"9866d91c3f80887d355be80888354554f13f600144a91e38a24b78abf89f5a53",
		"fb8e669124798746821ee25bd9e2a5e8153f968c773f50da9695f7a384c2ea65",
		"342525f6b121323347b8f36bdc75acc9d3bdc19845d29895612b629e7a5095e6",
	]);
	const original = parseLifeInput(JSON.parse(bytes[2] ?? "null"));
	expect(original.payloadDigest).toBe(
		"80e771be4c9d786f1389f89e8ec012f3d604a34950991755cadc6cda213a495f",
	);
	const authority = {
		settingsRevision: 1,
		posts: [{ id: parent.id, kind: "post", revision: 1 }],
		grants: [{ id: "reader", revision: 1 }],
	};
	expect(lifeDigest(parsePublicationAuthority(authority))).toBe(
		"6031a17b283d078d7881ba6ba5d7432feec62e6e2d31b8df0378aac7e533da10",
	);
	const frontier = f.current.interactions.observationSnapshot("world");
	f.seed();
	f.publish();
	f.deliver();
	f.reopen();
	expect(f.current.interactions.observationSnapshot("world", 1)).toEqual(
		frontier,
	);
	expect(
		f.db
			.prepare(
				"SELECT receipt_json FROM life_publication_interaction_receipts WHERE request_key='legacy-v1'",
			)
			.get()?.["receipt_json"],
	).toBe(bytes[0]);
	expect(
		f.db
			.prepare(
				"SELECT interaction_json FROM life_publication_interactions WHERE request_key='legacy-v1'",
			)
			.get()?.["interaction_json"],
	).toBe(bytes[1]);
	expect(
		f.db
			.prepare(
				"SELECT input_json FROM life_publication_observations WHERE interaction_id=? AND agent_id='a'",
			)
			.get(legacy.interaction.id)?.["input_json"],
	).toBe(bytes[2]);
});

test("generic application admission rejects a valid generated source without installing an input", () => {
	const store = publicationStoreFixture();
	try {
		const id = publicationObservationId("test-world", "generated", "lina");
		const source = {
			kind: "publication_interaction",
			observationId: id,
			interactionId: "generated",
			postId: records.reply.post.id,
			postRevision: 1,
			principal: { kind: "agent", agentId: "mira" },
			recipientAgentId: "lina",
			action: {
				kind: "generated_reply",
				segments: records.reply.post.segments,
			},
			roots: [{ rootId: "root-a", depth: 1 }],
		};
		const input = parseLifeInput({
			version: 3,
			worldId: "test-world",
			id,
			sourceRevision: 1,
			payloadDigest: lifeDigest(source),
			source,
			consumedLifeRevision: null,
		});
		expect(() => store.admitLifeInput(input)).toThrow("Trusted");
		expect(store.lifeInputs("test-world")).toEqual([]);
	} finally {
		store.close();
	}
});

test.each([
	[
		"missing charge",
		"DELETE FROM life_publication_chain_charges; DELETE FROM life_publication_chain_roots; DELETE FROM life_publication_chain_actions; DELETE FROM life_publication_chain_state",
	],
	["missing generated post", "DELETE FROM life_publication_posts"],
	["missing generated job", "DELETE FROM life_publication_jobs"],
	["missing observation source", "DELETE FROM fixture_inputs"],
] as const)(
	"actual SQLite reopen rejects %s without repairing history",
	(_name, sql) => {
		const f = fixture();
		f.seed();
		f.publish();
		f.deliver();
		f.db.exec("PRAGMA foreign_keys=OFF");
		f.db.exec(sql);
		const corrupt = f.snapshot();
		expect(() => f.reopen()).toThrow();
		expect(f.snapshot()).toEqual(corrupt);
	},
);

test("fully rehashed stopped generated receipt cannot replace the paid queued receipt", () => {
	const f = fixture();
	f.seed();
	f.publish();
	f.recipients = ["b"];
	f.deliver();
	const row = f.db
		.prepare("SELECT receipt_json FROM life_publication_interaction_receipts")
		.get();
	const receipt = JSON.parse(String(row?.["receipt_json"]));
	receipt.processing = "stopped";
	f.db
		.prepare(
			"UPDATE life_publication_interaction_receipts SET receipt_json=?,digest=?",
		)
		.run(canonicalLifeJson(receipt), lifeDigest(receipt));
	f.db
		.prepare("UPDATE life_publication_interaction_state SET digest=?")
		.run(lifeDigest(receipt));
	const stored = f.db
		.prepare("SELECT interaction_json FROM life_publication_interactions")
		.get();
	const interaction = JSON.parse(String(stored?.["interaction_json"]));
	interaction.processing = "stopped";
	f.db
		.prepare(
			"UPDATE life_publication_interactions SET interaction_json=?,digest=?",
		)
		.run(canonicalLifeJson(interaction), lifeDigest(interaction));
	expect(() => f.reopen()).toThrow("Forged generated publication receipt");
});

test("paid charge proof binds the original actor, roots, revision, limits and cooldown on each history read", () => {
	const f = fixture();
	f.seed();
	f.publish();
	f.deliver();
	const before = f.snapshot();
	for (const charge of [
		{ actorId: "different-actor" },
		{ roots: [{ rootId: "root-a", depth: 0 }] },
		{ lifeRevision: 10 },
		{ limits: { ...limits, maxActionsPerChain: 19 } },
		{ cooldown: false },
	]) {
		const row = f.db
			.prepare("SELECT record_json FROM life_publication_chain_actions")
			.get();
		const original = JSON.parse(String(row?.["record_json"]));
		// A fully rehashed alternate chain receipt is tested in a rolled-back transaction.
		expect(() =>
			f.transaction(() => {
				const forged = { ...original, ...charge },
					hash = lifeDigest(forged);
				f.db
					.prepare(
						"UPDATE life_publication_chain_actions SET record_json=?,digest=?",
					)
					.run(canonicalLifeJson(forged), hash);
				f.db
					.prepare("UPDATE life_publication_chain_state SET digest=?")
					.run(hash);
				f.db
					.prepare("UPDATE life_publication_chain_charges SET action_digest=?")
					.run(hash);
				f.current.interactions.validate();
			}),
		).toThrow();
		expect(f.snapshot()).toEqual(before);
	}
	f.reopen();
});
