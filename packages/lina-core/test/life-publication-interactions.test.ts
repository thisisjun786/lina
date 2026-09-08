import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalLifeJson, lifeDigest } from "../src/world/life-json.ts";
import type { LifeInput } from "../src/world/life-types.ts";
import { parseLifeInput } from "../src/world/life-validation.ts";
import {
	PUBLICATION_CHAINS_SCHEMA,
	PublicationChains,
} from "../src/world/publication-chains.ts";
import {
	type Access,
	PUBLICATION_INTERACTIONS_SCHEMA,
	PublicationInteractions,
} from "../src/world/publication-interactions.ts";
import type { PublicationPrincipal } from "../src/world/publication-types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
const viewer: PublicationPrincipal = { kind: "viewer", grantId: "grant" };
const agent: PublicationPrincipal = { kind: "agent", agentId: "alice" };
const body = { requestKey: "request", expectedPostRevision: 2, text: "Hello" };
const parent = {
	id: "parent",
	revision: 2,
	audience: ["recipient"],
	roots: [
		{ rootId: "root-a", depth: 0 },
		{ rootId: "root-b", depth: 2 },
	],
};

test("observation snapshots retain their exact receipt frontier after later interactions and restart", () => {
	const f = fixture();
	const before = f.owner.observationSnapshot("world");
	expect(before).toEqual({ revision: 0, records: [] });
	transaction(f.db, () => f.owner.reply("world", viewer, parent.id, body));
	const first = f.owner.observationSnapshot("world");
	expect(first.revision).toBe(1);
	expect(first.records).toHaveLength(2);
	transaction(f.db, () =>
		f.owner.reply("world", viewer, parent.id, {
			...body,
			requestKey: "second",
		}),
	);
	expect(f.owner.observationSnapshot("world").records).toHaveLength(4);
	expect(f.owner.observationSnapshot("world", first.revision)).toEqual(first);
	expect(f.owner.observationSnapshot("world", 0)).toEqual(before);
	expect(() => f.owner.observationSnapshot("world", 3)).toThrow();
	expect(() =>
		f.owner.observationSnapshot("world", Number.MAX_SAFE_INTEGER + 1),
	).toThrow();
	f.reopen();
	expect(f.owner.observationSnapshot("world", first.revision)).toEqual(first);
});
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

/** Real SQL seams on one isolated file, not a substitute WorldStore implementation. */
function fixture() {
	const directory = mkdtempSync(
		join(tmpdir(), "lina-publication-interactions-"),
	);
	const path = join(directory, "world.sqlite");
	let db = new DatabaseSync(path);
	db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL");
	db.exec(`
		CREATE TABLE worlds(id TEXT PRIMARY KEY) STRICT;
		INSERT INTO worlds VALUES('world'),('other');
		CREATE TABLE fixture_posts(world_id TEXT,post_id TEXT,post_json TEXT,visible INTEGER,
		 PRIMARY KEY(world_id,post_id)) STRICT;
		CREATE TABLE fixture_inputs(world_id TEXT,input_id TEXT,input_json TEXT,
		 PRIMARY KEY(world_id,input_id)) STRICT;
	`);
	db.prepare("INSERT INTO fixture_posts VALUES(?,?,?,1)").run(
		"world",
		parent.id,
		canonicalLifeJson(parent),
	);
	db.exec(PUBLICATION_CHAINS_SCHEMA);
	db.exec(PUBLICATION_INTERACTIONS_SCHEMA);
	const settings = {
		maxChainDepth: 4,
		maxActionsPerChain: 20,
		perAuthorCooldownSteps: 0,
	};
	let recipients = ["bob", "alice", "bob"];
	let fault: "post" | "admit" | "receipt" | null = null;
	let chargeCalls = 0;
	let admissionCalls = 0;
	function access(connection: DatabaseSync): Access {
		return {
			parent(worldId, principal, postId) {
				if (
					(principal.kind === "viewer" && principal.grantId !== "grant") ||
					(principal.kind === "agent" && principal.agentId !== "alice")
				)
					return null;
				const row = connection
					.prepare(
						"SELECT post_json FROM fixture_posts WHERE world_id=? AND post_id=? AND visible=1",
					)
					.get(worldId, postId);
				return row ? JSON.parse(String(row["post_json"])) : null;
			},
			agents: () => recipients,
			lifeRevision: () => 7,
			settingsRevision: () => 1,
			now: () => 100,
			reactionAllowed: (_world, id) => id === "heart",
			charge(worldId, key, roots, principal, lifeRevision) {
				chargeCalls++;
				return new PublicationChains(connection).charge(
					worldId,
					key,
					roots,
					lifeDigest(principal),
					lifeRevision,
					settings,
					false,
				).charged;
			},
			admit(input) {
				admissionCalls++;
				parseLifeInput(input);
				connection
					.prepare("INSERT INTO fixture_inputs VALUES(?,?,?)")
					.run(input.worldId, input.id, canonicalLifeJson(input));
				if (fault === "admit") throw Error("injected admission failure");
				return {
					worldId: input.worldId,
					inputId: input.id,
					payloadDigest:
						fault === "receipt" ? "0".repeat(64) : input.payloadDigest,
					replayed: false,
				};
			},
			input(worldId, inputId): LifeInput | null {
				const row = connection
					.prepare(
						"SELECT input_json FROM fixture_inputs WHERE world_id=? AND input_id=?",
					)
					.get(worldId, inputId);
				return row
					? parseLifeInput(JSON.parse(String(row["input_json"])))
					: null;
			},
			createPost(interaction) {
				connection.prepare("INSERT INTO fixture_posts VALUES(?,?,?,1)").run(
					interaction.worldId,
					interaction.postId,
					canonicalLifeJson({
						id: interaction.postId,
						revision: 1,
						audience: interaction.audience,
						roots: interaction.roots,
					}),
				);
				if (fault === "post") throw Error("injected post failure");
			},
		};
	}
	let owner = new PublicationInteractions(db, access(db));
	cleanup.push(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
	});
	return {
		path,
		settings,
		access,
		get db() {
			return db;
		},
		get owner() {
			return owner;
		},
		get charges() {
			return chargeCalls;
		},
		get admissions() {
			return admissionCalls;
		},
		set recipients(value: string[]) {
			recipients = value;
		},
		set fault(value: typeof fault) {
			fault = value;
		},
		run<T>(action: (owner: PublicationInteractions) => T): T {
			return transaction(db, () => action(owner));
		},
		reply(
			input = body,
			principal = viewer,
			postId = parent.id,
			world = "world",
		) {
			return transaction(db, () =>
				owner.reply(world, principal, postId, input),
			);
		},
		react(active: boolean, requestKey: string) {
			return transaction(db, () =>
				owner.react("world", viewer, parent.id, {
					requestKey,
					expectedPostRevision: 2,
					reactionId: "heart",
					active,
				}),
			);
		},
		reshare(requestKey: string) {
			return transaction(db, () =>
				owner.reshare("world", viewer, parent.id, {
					requestKey,
					expectedPostRevision: 2,
				}),
			);
		},
		reopen() {
			db.close();
			db = new DatabaseSync(path);
			db.exec("PRAGMA foreign_keys=ON");
			owner = new PublicationInteractions(db, access(db));
			owner.validate();
			new PublicationChains(db).validate();
		},
		snapshot() {
			return db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.all()
				.map((r) => [
					r["name"],
					db.prepare(`SELECT * FROM ${r["name"]} ORDER BY rowid`).all(),
				]);
		},
	};
}

test("reply persists exact actor, inherited roots, one input per allowed agent and replay across reopen", () => {
	const f = fixture();
	const first = f.reply();
	if (!first.interaction) throw Error("Expected effective reply");
	expect(first).toMatchObject({
		effective: true,
		replayed: false,
		interaction: {
			version: 1,
			principal: viewer,
			parentPostId: "parent",
			expectedPostRevision: 2,
			action: { kind: "reply", text: "Hello" },
			audience: ["recipient"],
			roots: [
				{ rootId: "root-a", depth: 1 },
				{ rootId: "root-b", depth: 3 },
			],
			processing: "queued",
			createdAt: 100,
			lifeRevision: 7,
		},
	});
	expect(first.interaction?.id).toMatch(/^pubint-[a-f0-9]{64}$/);
	expect(first.postId).toMatch(/^pubpost-[a-f0-9]{64}$/);
	expect(f.charges).toBe(1);
	expect(f.admissions).toBe(2);
	const observations = f.owner.observations("world");
	expect(observations.map((o) => o.source.recipientAgentId).sort()).toEqual([
		"alice",
		"bob",
	]);
	for (const observation of observations) {
		expect(observation.source).toMatchObject({
			postId: "parent",
			postRevision: 2,
			principal: viewer,
			action: { kind: "reply", text: "Hello" },
			roots: first.interaction?.roots,
		});
		expect(observation.inputId).toBe(observation.source.observationId);
	}
	const before = f.snapshot();
	expect(f.reply()).toEqual({ ...first, replayed: true });
	f.reopen();
	expect(f.reply()).toEqual({ ...first, replayed: true });
	expect(f.snapshot()).toEqual(before);
	expect(f.owner.get("world", first.interaction?.id ?? "missing")).toEqual(
		first.interaction,
	);
	expect(f.owner.list("other")).toEqual([]);
	expect(f.owner.observations("other")).toEqual([]);
});

test("reaction add/remove receipts audit noops against their historical state, including initial false", () => {
	const f = fixture();
	const absent = {
		interaction: null,
		postId: null,
		replayed: false,
		effective: false,
	};
	expect(f.react(false, "absent")).toEqual(absent);
	expect(f.charges).toBe(0);
	expect(f.admissions).toBe(0);
	const add = f.react(true, "add");
	expect(add.effective).toBe(true);
	expect(add.postId).toBeNull();
	expect(f.react(true, "same")).toEqual(absent);
	expect(f.react(false, "remove").effective).toBe(true);
	expect(f.react(true, "same")).toEqual({ ...absent, replayed: true });
	expect(f.react(false, "absent")).toEqual({ ...absent, replayed: true });
	expect(f.react(true, "add")).toEqual({ ...add, replayed: true });
	expect(f.owner.list("world")).toHaveLength(2);
	expect(f.charges).toBe(2);
	expect(f.admissions).toBe(4);
	f.reopen();
});

test("reshare dedupes principal and parent across different keys; replies remain distinct", () => {
	const f = fixture();
	const shared = f.reshare("one");
	expect(f.reshare("two")).toEqual({
		interaction: null,
		postId: shared.postId,
		replayed: false,
		effective: false,
	});
	f.reopen();
	expect(f.reshare("two").postId).toBe(shared.postId);
	expect(f.reshare("three").effective).toBe(false);
	const first = f.reply();
	expect(f.reply({ ...body, requestKey: "another" }).postId).not.toBe(
		first.postId,
	);
	expect(f.reply(body, agent).interaction?.principal).toEqual(agent);
	expect(f.owner.list("world")).toHaveLength(4);
});

test("exhausted roots still persist visible user action and child but produce no observation or input", () => {
	const f = fixture();
	f.settings.maxChainDepth = 2;
	const result = f.reply();
	expect(result.interaction?.processing).toBe("stopped");
	expect(result.interaction?.observationIds).toEqual([]);
	expect(f.owner.observations("world")).toEqual([]);
	expect(f.admissions).toBe(0);
	expect(
		f.db
			.prepare("SELECT post_id FROM fixture_posts WHERE post_id=?")
			.get(result.postId),
	).toBeTruthy();
	f.reopen();
	expect(f.reply()).toEqual({ ...result, replayed: true });
});

test("visibility is checked on replay; revision applies to fresh requests; rejected bodies leave no traces", () => {
	const f = fixture();
	const first = f.reply();
	const before = f.snapshot();
	for (const invoke of [
		() => f.reply({ ...body, text: "changed" }),
		() => f.reply(body, viewer, "missing"),
		() => f.reply({ ...body, requestKey: "stale", expectedPostRevision: 1 }),
		() => f.reply(body, { kind: "agent", agentId: "fake" }),
		() => f.reply(body, viewer, parent.id, "other"),
		() =>
			f.run((o) =>
				o.reply("world", viewer, parent.id, {
					...body,
					audience: ["outsider"],
				} as typeof body),
			),
		() =>
			f.run((o) =>
				o.react("world", viewer, parent.id, {
					requestKey: "bad-reaction",
					expectedPostRevision: 2,
					reactionId: "unknown",
					active: true,
				}),
			),
	])
		expect(invoke).toThrow();
	expect(f.snapshot()).toEqual(before);
	f.db
		.prepare("UPDATE fixture_posts SET post_json=? WHERE post_id='parent'")
		.run(canonicalLifeJson({ ...parent, revision: 3 }));
	expect(f.reply()).toEqual({ ...first, replayed: true });
	f.db.exec("UPDATE fixture_posts SET visible=0");
	expect(() => f.reply()).toThrow();
	expect(() => f.reopen()).not.toThrow();
});

for (const fault of ["post", "admit", "receipt"] as const) {
	test(`caller BEGIN IMMEDIATE rolls back all owners after ${fault} failure`, () => {
		const f = fixture();
		const before = f.snapshot();
		f.fault = fault;
		expect(() => f.reply()).toThrow();
		expect(f.snapshot()).toEqual(before);
		f.fault = null;
		f.reopen();
		expect(f.reply().effective).toBe(true);
	});
}

test("two real connections serialize an interrupted request and preserve the committed replay", () => {
	const f = fixture();
	const second = new DatabaseSync(f.path);
	cleanup.push(() => second.close());
	second.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0");
	const peer = new PublicationInteractions(second, f.access(second));
	f.db.exec("BEGIN IMMEDIATE");
	const first = f.owner.reply("world", viewer, parent.id, body);
	expect(() => second.exec("BEGIN IMMEDIATE")).toThrow();
	expect(peer.list("world")).toEqual([]);
	f.db.exec("COMMIT");
	expect(
		transaction(second, () => peer.reply("world", viewer, parent.id, body)),
	).toEqual({ ...first, replayed: true });
	peer.validate();
	f.reopen();
});

test("consumption metadata may change, but original admitted payload and observation stay immutable", () => {
	const f = fixture();
	const result = f.reply();
	for (const row of f.db
		.prepare("SELECT world_id,input_id,input_json FROM fixture_inputs")
		.all()) {
		const input = parseLifeInput(JSON.parse(String(row["input_json"])));
		f.db
			.prepare(
				"UPDATE fixture_inputs SET input_json=? WHERE world_id=? AND input_id=?",
			)
			.run(
				canonicalLifeJson({ ...input, consumedLifeRevision: 8 }),
				input.worldId,
				input.id,
			);
	}
	const before = f.snapshot();
	f.reopen();
	expect(f.reply()).toEqual({ ...result, replayed: true });
	expect(f.snapshot()).toEqual(before);
	for (const row of f.db
		.prepare("SELECT input_json FROM life_publication_observations")
		.all())
		expect(
			parseLifeInput(JSON.parse(String(row["input_json"])))
				.consumedLifeRevision,
		).toBeNull();
});

test("unsafe caller JSON and invalid parent data fail before any durable writes or callback", () => {
	const f = fixture();
	const before = f.snapshot();
	let getters = 0;
	const accessor = {
		...body,
		get text() {
			getters++;
			return "unsafe";
		},
	};
	for (const input of [
		accessor,
		{ ...body, expectedPostRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...body, text: " " },
		{ ...body, text: "x".repeat(32769) },
		{ ...body, [Symbol("hidden")]: "value" },
		Object.assign(Object.create({ hidden: true }), body),
	]) {
		expect(() => f.reply(input)).toThrow();
	}
	expect(getters).toBe(0);
	expect(f.snapshot()).toEqual(before);
	expect(() => f.owner.reply("world", viewer, parent.id, body)).toThrow(
		"caller transaction",
	);
	for (const badParent of [
		{ ...parent, roots: [] },
		{ ...parent, audience: [] },
		{ ...parent, roots: [...parent.roots, parent.roots[0]] },
		{ ...parent, audience: ["recipient", "recipient"] },
		{ ...parent, roots: [{ rootId: "root", depth: Number.MAX_SAFE_INTEGER }] },
	]) {
		f.db
			.prepare("UPDATE fixture_posts SET post_json=? WHERE post_id='parent'")
			.run(JSON.stringify(badParent));
		expect(() => f.reply()).toThrow();
	}
	expect(f.charges).toBe(0);
	expect(f.admissions).toBe(0);
});

test("a same-key different visible parent conflicts and world/principal identities remain independent", () => {
	const f = fixture();
	const first = f.reply();
	f.db
		.prepare("INSERT INTO fixture_posts VALUES(?,?,?,1)")
		.run(
			"world",
			"second-parent",
			canonicalLifeJson({ ...parent, id: "second-parent" }),
		);
	f.db
		.prepare("INSERT INTO fixture_posts VALUES(?,?,?,1)")
		.run("other", parent.id, canonicalLifeJson(parent));
	expect(() => f.reply(body, viewer, "second-parent")).toThrow("conflict");
	const secondWorld = f.reply(body, viewer, parent.id, "other");
	expect(secondWorld.interaction?.id).not.toBe(first.interaction?.id);
	expect(secondWorld.postId).not.toBe(first.postId);
	expect(f.reply(body, agent).interaction?.id).not.toBe(first.interaction?.id);
	f.reopen();
});

test("zero observing agents is a valid queued action and stopped reactions do not produce inputs", () => {
	const f = fixture();
	f.recipients = [];
	expect(f.reply().interaction?.processing).toBe("queued");
	expect(f.admissions).toBe(0);
	f.settings.maxActionsPerChain = 0;
	expect(f.react(true, "stopped").interaction).toMatchObject({
		processing: "stopped",
		observationIds: [],
	});
	expect(f.react(true, "noop").effective).toBe(false);
	expect(f.admissions).toBe(0);
	f.reopen();
});

test("reshare and reaction state are independent for a second trusted principal", () => {
	const f = fixture();
	const shared = f.reshare("shared");
	f.react(true, "added");
	const otherShare = f.run((owner) =>
		owner.reshare("world", agent, parent.id, {
			requestKey: "shared",
			expectedPostRevision: 2,
		}),
	);
	expect(otherShare.effective).toBe(true);
	expect(otherShare.postId).not.toBe(shared.postId);
	expect(
		f.run((owner) =>
			owner.react("world", agent, parent.id, {
				requestKey: "added",
				expectedPostRevision: 2,
				reactionId: "heart",
				active: true,
			}),
		).effective,
	).toBe(true);
	expect(f.owner.list("world")).toHaveLength(4);
	f.reopen();
});

test("an enclosing transaction failure rolls back a fully completed reply including all chain charges", () => {
	const f = fixture();
	const before = f.snapshot();
	expect(() =>
		f.run((owner) => {
			owner.reply("world", viewer, parent.id, body);
			throw Error("enclosing caller failed");
		}),
	).toThrow("enclosing caller failed");
	expect(f.snapshot()).toEqual(before);
	f.reopen();
	expect(f.reply().effective).toBe(true);
});

for (const [name, sql] of [
	[
		"missing observation",
		"DELETE FROM life_publication_observations WHERE rowid=(SELECT min(rowid) FROM life_publication_observations)",
	],
	["missing receipt", "DELETE FROM life_publication_interaction_receipts"],
	["missing interaction", "DELETE FROM life_publication_interactions"],
	["missing admitted input", "DELETE FROM fixture_inputs"],
	["missing receipt head", "DELETE FROM life_publication_interaction_state"],
	[
		"altered interaction digest",
		"UPDATE life_publication_interactions SET digest='bad'",
	],
	[
		"altered observation owner",
		"UPDATE life_publication_observations SET agent_id='fake' WHERE agent_id='alice'",
	],
	[
		"unsafe receipt sequence",
		"UPDATE life_publication_interaction_receipts SET sequence=9007199254740991",
	],
] as const) {
	test(`actual-file reopen rejects ${name}`, () => {
		const f = fixture();
		f.reply();
		f.db.exec("PRAGMA foreign_keys=OFF");
		f.db.exec(sql);
		const corrupt = f.snapshot();
		expect(() => f.reopen()).toThrow();
		expect(f.snapshot()).toEqual(corrupt);
	});
}

for (const [name, sql] of [
	[
		"wrong reaction state",
		"UPDATE life_publication_reaction_heads SET active=1",
	],
	[
		"regressed reaction head",
		`UPDATE life_publication_reaction_heads SET interaction_id=(
		SELECT interaction_id FROM life_publication_interactions WHERE request_key='add')`,
	],
	["missing reaction head", "DELETE FROM life_publication_reaction_heads"],
	[
		"wrong reaction actor",
		"UPDATE life_publication_reaction_heads SET principal_digest='fake'",
	],
] as const) {
	test(`actual-file reopen rejects ${name}`, () => {
		const f = fixture();
		f.react(true, "add");
		f.react(false, "remove");
		f.db.exec(sql);
		expect(() => f.reopen()).toThrow();
	});
}

test("rehashing a noop into an effective request without an interaction is detected by historical replay", () => {
	const f = fixture();
	f.react(false, "absent");
	const row = f.db
		.prepare("SELECT receipt_json FROM life_publication_interaction_receipts")
		.get();
	const receipt = JSON.parse(String(row?.["receipt_json"]));
	receipt.request.action.active = true;
	f.db
		.prepare(
			"UPDATE life_publication_interaction_receipts SET receipt_json=?,digest=?,request_digest=?",
		)
		.run(
			canonicalLifeJson(receipt),
			lifeDigest(receipt),
			lifeDigest(receipt.request),
		);
	f.db
		.prepare("UPDATE life_publication_interaction_state SET digest=?")
		.run(lifeDigest(receipt));
	expect(() => f.reopen()).toThrow("noop receipt");
});

for (const [name, change] of [
	[
		"fake actor",
		(value: Record<string, unknown>) => {
			value["principal"] = { kind: "agent", agentId: "fake" };
		},
	],
	[
		"expanded audience",
		(value: Record<string, unknown>) => {
			value["audience"] = ["recipient", "secret"];
		},
	],
	[
		"shortened roots",
		(value: Record<string, unknown>) => {
			value["roots"] = [{ rootId: "new-root", depth: 0 }];
		},
	],
	[
		"duplicate observations",
		(value: Record<string, unknown>) => {
			value["observationIds"] = ["same", "same"];
		},
	],
	[
		"unsafe life revision",
		(value: Record<string, unknown>) => {
			value["lifeRevision"] = -1;
		},
	],
	[
		"unknown field",
		(value: Record<string, unknown>) => {
			value["hidden"] = true;
		},
	],
] as const) {
	test(`rehashing interaction ${name} cannot override the original receipt`, () => {
		const f = fixture();
		f.reply();
		const row = f.db
			.prepare("SELECT interaction_json FROM life_publication_interactions")
			.get();
		const interaction: Record<string, unknown> = JSON.parse(
			String(row?.["interaction_json"]),
		);
		change(interaction);
		f.db
			.prepare(
				"UPDATE life_publication_interactions SET interaction_json=?,digest=?",
			)
			.run(canonicalLifeJson(interaction), lifeDigest(interaction));
		expect(() => f.reopen()).toThrow("corrupt publication interaction");
	});
}

test("validly rehashed admitted input with a different actor fails original-payload recovery audit", () => {
	const f = fixture();
	f.reply();
	const row = f.db
		.prepare("SELECT input_json FROM fixture_inputs LIMIT 1")
		.get();
	const input = parseLifeInput(JSON.parse(String(row?.["input_json"])));
	if (input.version !== 3) throw Error("Expected publication fixture input");
	input.source.principal = { kind: "agent", agentId: "fake" };
	input.payloadDigest = lifeDigest(input.source);
	parseLifeInput(input);
	f.db
		.prepare("UPDATE fixture_inputs SET input_json=? WHERE input_id=?")
		.run(canonicalLifeJson(input), input.id);
	expect(() => f.reopen()).toThrow(
		"admitted publication input owner or payload",
	);
});
