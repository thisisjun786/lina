import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/agents/conversation.ts";
import { AgentStore } from "../src/agents/store.ts";
import {
	AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA,
	AGENT_VISUAL_SCHEMA,
} from "../src/agents/visual-schema.ts";
import { learnedFixture } from "./learned-source-fixture.ts";

/** Remove only the known schema2 owner when constructing an actual Agent0 test fixture. */
function stripVisualFixture(db: DatabaseSync): void {
	const tables = [
		...(AGENT_VISUAL_SCHEMA + AGENT_AVATAR_CANDIDATE_CAPACITY_SCHEMA).matchAll(
			/CREATE TABLE (agent_[a-z_]+) /g,
		),
	].map((match) => match[1]);
	for (const table of tables.reverse()) db.exec(`DROP TABLE ${table}`);
}

for (const kind of ["preference", "reflection"] as const)
	for (const mode of ["read", "reopen"] as const)
		for (const removed of ["r", "context"] as const)
			test(`N3: ${kind} full receipt proof cannot lose ${removed} ancestry on ${mode}`, () => {
				const f = learnedFixture(),
					path = join(f.root, "bound.sqlite"),
					r = f.episode("r"),
					context = f.episode("context"),
					p = {
						...r,
						sourceProofs: [...r.sourceProofs, ...context.sourceProofs],
					};
				const s =
					kind === "preference"
						? new ConversationStore(path)
						: new AgentStore(path);
				if (s instanceof AgentStore) {
					s.create(f.profile);
					s.applyReflection(
						"lina",
						{
							profileRevision: 1,
							dynamicsRevision: 0,
							requestId: "r",
							sourceEntryIds: ["r-user"],
							mood: { label: "calm", reason: "tea" },
						},
						() => true,
						p,
					);
				} else
					s.observePreferences(
						"lina",
						"r",
						"r-user",
						"tea",
						[{ dimension: "emoji", value: "none", quote: "tea" }],
						() => f.source("r"),
						0,
						p,
					);
				const table =
					kind === "preference"
						? "conversation_preference_sources"
						: "agent_learning_receipts";
				const db = new DatabaseSync(path);
				const row = db.prepare(`SELECT source_proofs FROM ${table}`).get();
				const proofs = JSON.parse(String(row?.["source_proofs"])).filter(
					(v: { entryId: string }) => v.entryId !== `${removed}-assistant`,
				);
				db.prepare(`UPDATE ${table} SET source_proofs=?`).run(
					JSON.stringify(proofs),
				);
				db.close();
				f.revoke(removed);
				try {
					if (mode === "read") {
						expect(() =>
							s instanceof AgentStore
								? s.modelDynamics("lina", f.lookup)
								: s.modelPreferences("lina", f.lookup),
						).toThrow(/proof|receipt|integrity/);
					} else {
						s.close();
						expect(() =>
							kind === "preference"
								? new ConversationStore(path)
								: new AgentStore(path),
						).toThrow(/proof|receipt|integrity/);
					}
				} finally {
					s.close();
					f.close();
				}
			});

test("N3: unbound old learned receipt JSON is retained but never qualifies, and fresh ordinary learning still progresses", () => {
	const f = learnedFixture(),
		ap = join(f.root, "agents.sqlite"),
		cp = join(f.root, "preferences.sqlite");
	let a = new AgentStore(ap),
		c = new ConversationStore(cp);
	a.create(f.profile);
	const old = f.episode("old");
	a.applyReflection(
		"lina",
		{
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "old",
			sourceEntryIds: ["old-user"],
			mood: { label: "old", reason: "tea" },
		},
		() => true,
		old,
	);
	c.observePreferences(
		"lina",
		"old",
		"old-user",
		"tea",
		[{ dimension: "emoji", value: "none", quote: "tea" }],
		() => f.source("old"),
		0,
		old,
	);
	a.close();
	c.close();
	const ad = new DatabaseSync(ap),
		cd = new DatabaseSync(cp);
	ad.exec(
		"UPDATE agent_learning_receipts SET input_json=json_extract(input_json,'$.input')",
	);
	cd.exec(
		"UPDATE conversation_preference_receipts SET fingerprint=json_remove(fingerprint,'$.provenance')",
	);
	const ar = ad.prepare("SELECT * FROM agent_learning_receipts").get(),
		cr = cd.prepare("SELECT * FROM conversation_preference_receipts").get();
	ad.close();
	cd.close();
	try {
		a = new AgentStore(ap);
		c = new ConversationStore(cp);
		expect(a.modelDynamics("lina", f.lookup).dynamics.mood).toBeNull();
		expect(c.modelPreferences("lina", f.lookup).items).toEqual([]);
		const ac = new DatabaseSync(ap),
			cc = new DatabaseSync(cp);
		expect(ac.prepare("SELECT * FROM agent_learning_receipts").get()).toEqual(
			ar,
		);
		expect(
			cc.prepare("SELECT * FROM conversation_preference_receipts").get(),
		).toEqual(cr);
		ac.close();
		cc.close();
		const fresh = f.episode("fresh");
		a.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: a.dynamics("lina").revision,
				requestId: "fresh",
				sourceEntryIds: ["fresh-user"],
				mood: { label: "fresh", reason: "tea" },
			},
			() => true,
			fresh,
		);
		c.observePreferences(
			"lina",
			"fresh",
			"fresh-user",
			"tea",
			[{ dimension: "emoji", value: "sparing", quote: "tea" }],
			() => f.source("fresh"),
			1,
			fresh,
		);
		a.close();
		c.close();
		a = new AgentStore(ap);
		c = new ConversationStore(cp);
		expect(a.modelDynamics("lina", f.lookup).dynamics.mood?.label).toBe(
			"fresh",
		);
		expect(c.modelPreferences("lina", f.lookup).items[0]?.value).toBe(
			"sparing",
		);
	} finally {
		a.close();
		c.close();
		f.close();
	}
});

test("N3: intact receipts retain all unquoted context proofs across reopen and fail current qualification after context revocation", () => {
	const f = learnedFixture(),
		ap = join(f.root, "agents.sqlite"),
		cp = join(f.root, "preferences.sqlite");
	let a = new AgentStore(ap),
		c = new ConversationStore(cp);
	a.create(f.profile);
	const r = f.episode("r"),
		context = f.episode("context"),
		p = { ...r, sourceProofs: [...r.sourceProofs, ...context.sourceProofs] };
	try {
		a.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "r",
				sourceEntryIds: ["r-user"],
				mood: { label: "calm", reason: "tea" },
			},
			() => true,
			p,
		);
		c.observePreferences(
			"lina",
			"r",
			"r-user",
			"tea",
			[{ dimension: "emoji", value: "none", quote: "tea" }],
			() => f.source("r"),
			0,
			p,
		);
		a.close();
		c.close();
		a = new AgentStore(ap);
		c = new ConversationStore(cp);
		expect(a.modelDynamics("lina", f.lookup).sourceProofs).toHaveLength(4);
		expect(c.modelPreferences("lina", f.lookup).sourceProofs).toHaveLength(4);
		f.revoke("context");
		expect(a.modelDynamics("lina", f.lookup).dynamics.mood).toBeNull();
		expect(c.modelPreferences("lina", f.lookup).items).toEqual([]);
		expect(a.dynamics("lina").mood?.label).toBe("calm");
		expect(c.getPreferences("lina").items).toHaveLength(1);
	} finally {
		a.close();
		c.close();
		f.close();
	}
});

test("learned state cannot forge a value using an unrelated ordinary receipt", () => {
	const f = learnedFixture(),
		path = join(f.root, "a.sqlite");
	const s = new AgentStore(path);
	s.create(f.profile);
	for (const r of ["one", "two"])
		s.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: s.dynamics("lina").revision,
				requestId: r,
				sourceEntryIds: [`${r}-user`],
				interests: ["tea"],
			},
			() => true,
			f.episode(r),
		);
	s.close();
	const db = new DatabaseSync(path);
	db.exec(
		"UPDATE agent_learning_state SET data=json_set(data,'$.values.interests[0].value','forged')",
	);
	db.close();
	try {
		expect(() => new AgentStore(path)).toThrow();
	} finally {
		f.close();
	}
});
test("legacy exact Agent0 and Conversation1 migrate without rewriting original learned bytes", () => {
	const f = learnedFixture(),
		ap = join(f.root, "a.sqlite"),
		cp = join(f.root, "c.sqlite");
	let a = new AgentStore(ap),
		c = new ConversationStore(cp);
	a.create(f.profile);
	a.applyReflection(
		"lina",
		{
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "legacy",
			sourceEntryIds: ["old"],
			mood: { label: "legacy", reason: "old" },
			interests: ["tea"],
		},
		() => true,
	);
	c.observePreferences(
		"lina",
		"legacy",
		"old",
		"tea",
		[{ dimension: "emoji", value: "none", quote: "tea" }],
		() => ({ entryId: "old", role: "user", text: "tea" }),
	);
	a.close();
	c.close();
	const ad = new DatabaseSync(ap),
		cd = new DatabaseSync(cp);
	stripVisualFixture(ad);
	ad.exec(
		"DROP TABLE agent_learning_history;DROP TABLE agent_learning_state;DROP TABLE agent_learning_receipts;PRAGMA user_version=0",
	);
	cd.exec(
		"DROP TABLE conversation_preference_history;DROP TABLE conversation_preference_sources;UPDATE conversation_meta SET value='1' WHERE key='schema_version';PRAGMA user_version=1",
	);
	const ar = ad.prepare("SELECT * FROM agent_dynamics").get(),
		cr = cd.prepare("SELECT * FROM conversation_preferences").get();
	ad.close();
	cd.close();
	try {
		a = new AgentStore(ap);
		c = new ConversationStore(cp);
		expect(a.modelDynamics("lina", f.lookup).dynamics.mood).toBeNull();
		expect(c.modelPreferences("lina", f.lookup).items).toEqual([]);
		const ac = new DatabaseSync(ap),
			cc = new DatabaseSync(cp);
		expect(ac.prepare("SELECT * FROM agent_dynamics").get()).toEqual(ar);
		expect(cc.prepare("SELECT * FROM conversation_preferences").get()).toEqual(
			cr,
		);
		expect(ac.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
		expect(cc.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(2);
		ac.close();
		cc.close();
	} finally {
		a.close();
		c.close();
		f.close();
	}
});
test("both learned-store migrations validate final DDL and roll back corruption", () => {
	for (const kind of ["agent", "conversation"]) {
		const f = learnedFixture(),
			path = join(f.root, "store.sqlite");
		const open = () =>
			kind === "agent" ? new AgentStore(path) : new ConversationStore(path);
		const s = open();
		s.close();
		const db = new DatabaseSync(path);
		if (kind === "agent") stripVisualFixture(db);
		if (kind === "agent")
			db.exec(
				"DROP TABLE agent_learning_history;DROP TABLE agent_learning_state;DROP TABLE agent_learning_receipts;PRAGMA user_version=0",
			);
		else
			db.exec(
				"DROP TABLE conversation_preference_history;DROP TABLE conversation_preference_sources;UPDATE conversation_meta SET value='1' WHERE key='schema_version';PRAGMA user_version=1",
			);
		db.close();
		const original = DatabaseSync.prototype.exec;
		const patch = spyOn(DatabaseSync.prototype, "exec").mockImplementation(
			function (this: DatabaseSync, sql: string) {
				original.call(this, sql);
				if (
					sql.includes(
						`CREATE TABLE ${kind === "agent" ? "agent_learning_receipts" : "conversation_preference_sources"}`,
					)
				)
					original.call(this, "CREATE TABLE unexpected_ddl(x TEXT) STRICT");
			},
		);
		try {
			expect(open).toThrow(/schema/);
		} finally {
			patch.mockRestore();
		}
		const check = new DatabaseSync(path);
		try {
			expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
				kind === "agent" ? 0 : 1,
			);
			expect(
				check
					.prepare("SELECT 1 FROM sqlite_schema WHERE name='unexpected_ddl'")
					.get(),
			).toBeUndefined();
		} finally {
			check.close();
			f.close();
		}
	}
});
test("malformed proof rows reject before writes", () => {
	for (const kind of ["agent", "conversation"]) {
		const f = learnedFixture(),
			path = join(f.root, "store.sqlite");
		const p = f.episode("r");
		if (kind === "agent") {
			const s = new AgentStore(path);
			s.create(f.profile);
			s.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: "r",
					sourceEntryIds: ["r-user"],
				},
				() => true,
				p,
			);
			s.close();
		} else {
			const s = new ConversationStore(path);
			s.observePreferences(
				"lina",
				"r",
				"r-user",
				"tea",
				[],
				() => f.source("r"),
				0,
				p,
			);
			s.close();
		}
		const db = new DatabaseSync(path);
		db.exec(
			`UPDATE ${kind === "agent" ? "agent_learning_receipts" : "conversation_preference_sources"} SET source_proofs='[]'`,
		);
		db.close();
		try {
			expect(() =>
				kind === "agent" ? new AgentStore(path) : new ConversationStore(path),
			).toThrow(/proof/);
		} finally {
			f.close();
		}
	}
});

test("preference history rejects a valid-looking value unsupported by its receipt", () => {
	const f = learnedFixture(),
		path = join(f.root, "preferences.sqlite"),
		s = new ConversationStore(path);
	s.observePreferences(
		"lina",
		"r",
		"r-user",
		"tea",
		[{ dimension: "verbosity", value: "brief", quote: "tea" }],
		() => f.source("r"),
		0,
		f.episode("r"),
	);
	s.clearPreferences("lina", 1);
	s.close();
	const db = new DatabaseSync(path);
	db.exec(
		"UPDATE conversation_preference_history SET data=json_set(data,'$.items[0].value','detailed') WHERE event='reset'",
	);
	db.close();
	try {
		expect(() => new ConversationStore(path)).toThrow(/history|projection/);
	} finally {
		f.close();
	}
});

test("legacy CHECK drift is rejected without completing a migration", () => {
	const f = learnedFixture(),
		path = join(f.root, "preferences.sqlite"),
		s = new ConversationStore(path);
	s.close();
	const db = new DatabaseSync(path);
	db.exec(
		"DROP TABLE conversation_preference_history;DROP TABLE conversation_preference_sources;UPDATE conversation_meta SET value='1' WHERE key='schema_version';PRAGMA user_version=1",
	);
	const ddl = String(
		db
			.prepare(
				"SELECT sql FROM sqlite_schema WHERE name='conversation_profiles'",
			)
			.get()?.["sql"],
	);
	db.exec("DROP TABLE conversation_profiles");
	db.exec(ddl.replace("CHECK(revision >= 1)", "CHECK(revision >= 0)"));
	db.close();
	try {
		expect(() => new ConversationStore(path)).toThrow(/schema/);
		const check = new DatabaseSync(path);
		expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
			1,
		);
		check.close();
	} finally {
		f.close();
	}
});

test("invalid legacy dynamics are audited before adding learned tables", () => {
	const f = learnedFixture(),
		path = join(f.root, "agents.sqlite"),
		s = new AgentStore(path);
	s.create(f.profile);
	s.close();
	const db = new DatabaseSync(path);
	stripVisualFixture(db);
	db.exec(
		"DROP TABLE agent_learning_history;DROP TABLE agent_learning_state;DROP TABLE agent_learning_receipts;PRAGMA user_version=0;UPDATE agent_dynamics SET mood='false'",
	);
	db.close();
	try {
		expect(() => new AgentStore(path)).toThrow(/mood/);
		const check = new DatabaseSync(path);
		expect(check.prepare("PRAGMA user_version").get()?.["user_version"]).toBe(
			0,
		);
		expect(
			check
				.prepare(
					"SELECT 1 FROM sqlite_schema WHERE name='agent_learning_receipts'",
				)
				.get(),
		).toBeUndefined();
		check.close();
	} finally {
		f.close();
	}
});
