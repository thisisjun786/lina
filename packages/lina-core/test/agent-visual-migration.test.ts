import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AGENT_LEARNING_SCHEMA } from "../src/agents/agent-learning.ts";
import { AGENT_SCHEMA, CANDIDATE_SCHEMA } from "../src/agents/agent-schema.ts";
import { AgentStore } from "../src/agents/store.ts";
import { requireVisualRecord } from "../src/agents/visual-validation.ts";

let dir: string, path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lina-visual-migrate-"));
	path = join(dir, "agents.sqlite");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function legacy() {
	const db = new DatabaseSync(path);
	db.exec(
		AGENT_SCHEMA +
			CANDIDATE_SCHEMA +
			AGENT_LEARNING_SCHEMA +
			"PRAGMA user_version=1",
	);
	db.prepare("INSERT INTO agent_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
		"lina",
		"Lina",
		"assistant",
		"curious",
		"warm",
		"private lore",
		"eyes",
		"[]",
		"a".repeat(64),
		"adaptive",
		4,
	);
	db.exec(
		"INSERT INTO agent_dynamics VALUES('lina',0,NULL,'[]','[]','[]','request'); INSERT INTO agent_receipts VALUES('lina','request'); INSERT INTO agent_candidates VALUES('lina','interest','jazz','[\"request\"]')",
	);
	return db;
}
function snapshot(db: DatabaseSync) {
	return db
		.prepare(
			"SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
		)
		.all();
}
test("real schema1 migration preserves every original row, candidates and captured legacy authority", () => {
	const db = legacy(),
		schema = snapshot(db),
		tables = schema
			.filter((r) => String(r["sql"]).startsWith("CREATE TABLE"))
			.map((r) => String(r["name"]));
	const rows = tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
	db.close();
	let store = new AgentStore(path);
	expect(store.pendingGrowth("lina").interests).toEqual(["jazz"]);
	expect(store.visual("lina").referenceLimits).toBeNull();
	const migrated = new DatabaseSync(path);
	expect(migrated.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
		3,
	);
	for (const [i, t] of tables.entries())
		expect(migrated.prepare(`SELECT * FROM ${t}`).all()).toEqual(
			requireVisualRecord(rows[i]),
		);
	migrated.close();
	store.syncAvatarInventory([
		{ fileId: "a.png", sha256: "a".repeat(64), mime: "image/png", size: 100 },
	]);
	store.registerLegacyAvatar(
		"lina",
		{ sha256: "a".repeat(64), mime: "image/png", size: 100 },
		() => true,
	);
	expect(store.avatarAuthorities("a".repeat(64))).toHaveLength(1);
	store.update("lina", 4, { avatarId: "b".repeat(64) });
	store.syncAvatarInventory([
		{ fileId: "b.png", sha256: "b".repeat(64), mime: "image/png", size: 100 },
	]);
	expect(() =>
		store.registerLegacyAvatar(
			"lina",
			{ sha256: "b".repeat(64), mime: "image/png", size: 100 },
			() => true,
		),
	).toThrow(/legacy.*source/);
	store.close();
	store = new AgentStore(path);
	expect(store.avatarAuthorities("a".repeat(64))).toHaveLength(1);
	expect(store.avatarAuthorities("b".repeat(64))).toEqual([]);
	store.close();
});
for (const [name, sql] of [
	["profile", "UPDATE agent_profiles SET interests='[1]'"],
	["dynamics", "UPDATE agent_dynamics SET mood='{}'"],
	["candidates", "UPDATE agent_candidates SET request_ids='[\"missing\"]'"],
	["learning", "INSERT INTO agent_learning_state VALUES('lina','{}')"],
] as const)
	test(`corrupt schema1 ${name} rejects before DDL and leaves original schema intact`, () => {
		const db = legacy();
		db.exec(sql);
		const before = snapshot(db);
		db.close();
		expect(() => new AgentStore(path)).toThrow();
		const after = new DatabaseSync(path);
		expect(snapshot(after)).toEqual(before);
		expect(after.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
			1,
		);
		after.close();
	});
test("schema2 current/history corruption rejects actual reopen", () => {
	const db = legacy();
	db.close();
	const store = new AgentStore(path);
	store.update("lina", 4, { avatarId: "b".repeat(64) });
	store.close();
	const bad = new DatabaseSync(path);
	bad.exec("UPDATE agent_visuals SET data=json_set(data,'$.pinned',1)");
	bad.close();
	expect(() => new AgentStore(path)).toThrow();
});

test("missing schema1 dynamics rejects before migration", () => {
	const db = legacy();
	db.exec("DELETE FROM agent_dynamics");
	const before = snapshot(db);
	db.close();
	expect(() => new AgentStore(path)).toThrow(/dynamics/);
	const check = new DatabaseSync(path);
	expect(snapshot(check)).toEqual(before);
	check.close();
});

test("schema1 migration retains populated learning history and raw pending candidates byte-for-byte", () => {
	const sourcePath = join(dir, "learning-source.sqlite"),
		source = new AgentStore(sourcePath);
	source.create({
		id: "lina",
		name: "Lina",
		role: "assistant",
		personality: "curious",
		voice: "warm",
		profile: "lore",
		appearance: "eyes",
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	});
	for (const requestId of ["one", "two", "pending"])
		source.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: source.dynamics("lina").revision,
				requestId,
				sourceEntryIds: [requestId],
				interests: requestId === "pending" ? ["jazz"] : ["chess"],
				mood: { label: "calm", reason: "conversation" },
			},
			() => true,
		);
	const expectedDynamics = source.dynamics("lina");
	source.close();
	const old = new DatabaseSync(path);
	old.exec(
		AGENT_SCHEMA +
			CANDIDATE_SCHEMA +
			AGENT_LEARNING_SCHEMA +
			"PRAGMA user_version=1",
	);
	const existing = new DatabaseSync(sourcePath),
		tables = old
			.prepare(
				"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'",
			)
			.all()
			.map((r) => String(r["name"]));
	const before = new Map<
		string,
		ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>
	>();
	for (const table of tables) {
		const rows = existing.prepare(`SELECT * FROM ${table}`).all();
		before.set(table, rows);
		for (const row of rows)
			old
				.prepare(
					`INSERT INTO ${table} VALUES(${Object.keys(row)
						.map(() => "?")
						.join(",")})`,
				)
				.run(...Object.values(row));
	}
	expect(before.get("agent_learning_history")?.length).toBeGreaterThan(0);
	expect(before.get("agent_learning_state")?.length).toBe(1);
	existing.close();
	old.close();
	const migrated = new AgentStore(path);
	expect(migrated.dynamics("lina")).toEqual(expectedDynamics);
	expect(migrated.pendingGrowth("lina").interests).toEqual(["jazz"]);
	migrated.close();
	const check = new DatabaseSync(path);
	for (const table of tables)
		expect(check.prepare(`SELECT * FROM ${table}`).all()).toEqual(
			requireVisualRecord(before.get(table)),
		);
	check.close();
});

test("profile history begins at the actual legacy revision and captures every subsequent authored write", () => {
	const old = legacy();
	old.close();
	const store = new AgentStore(path);
	try {
		const current = store.get("lina");
		if (!current) throw Error("missing fixture profile");
		expect(current.revision).toBe(4);
		const inspect = new DatabaseSync(path);
		expect(
			inspect.prepare("SELECT revision FROM agent_visual_profiles").all(),
		).toEqual([{ revision: 4 }]);
		expect(
			JSON.parse(
				String(
					inspect
						.prepare("SELECT data FROM agent_visual_profiles WHERE revision=4")
						.get()?.["data"],
				),
			),
		).toEqual(current);
		inspect.close();
		const settings = {
			anchors: ["eyes"],
			canonicalReferenceId: null,
			textIdentity: "approved identity",
			avatarPolicy: null,
			referenceLimits: { maxAssets: 1, maxTotalBytes: 100 },
			maxHistoryRecords: 100,
		};
		store.updateVisual("lina", 1, settings);
		store.putVisualGrant("lina", 2, {
			version: 1,
			id: "grant",
			agentId: "lina",
			revision: 1,
			subject: {
				kind: "text_identity",
				identityDigest: visualIdentityDigest(settings),
			},
			providerUse: true,
			purposes: [{ kind: "avatar" }],
			revoked: false,
		});
		const frozen = store.freezeVisualIdentity("lina", { kind: "avatar" });
		expect(() =>
			store.validateFrozenVisualIdentity({ ...frozen, profileRevision: 3 }),
		).toThrow(/historical/);
		store.update("lina", 4, { voice: "quiet" });
		const { revision: _r, ...input } = requireVisualRecord(store.get("lina"));
		store.applyAuthored(
			{ ...input, personality: "authored" },
			5,
			"authored-operation",
		);
		store.update("lina", 6, { avatarId: "b".repeat(64) });
		store.close();
		const reopened = new AgentStore(path);
		try {
			expect(() => reopened.validateFrozenVisualIdentity(frozen)).not.toThrow();
			expect(reopened.get("lina")).toMatchObject({
				revision: 7,
				voice: "quiet",
				personality: "authored",
				avatarId: "b".repeat(64),
			});
		} finally {
			reopened.close();
		}
		const records = new DatabaseSync(path);
		expect(
			records
				.prepare(
					"SELECT revision,visual_revision FROM agent_visual_profiles ORDER BY revision",
				)
				.all(),
		).toEqual([
			{ revision: 4, visual_revision: 1 },
			{ revision: 5, visual_revision: 3 },
			{ revision: 6, visual_revision: 3 },
			{ revision: 7, visual_revision: 4 },
		]);
		expect(
			JSON.parse(
				String(
					records
						.prepare("SELECT data FROM agent_visual_profiles WHERE revision=4")
						.get()?.["data"],
				),
			),
		).toEqual(current);
		records.close();
	} finally {
		store.close();
	}
});

import { visualIdentityDigest } from "../src/agents/visual-validation.ts";
