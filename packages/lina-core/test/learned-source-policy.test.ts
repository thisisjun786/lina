import { expect, test } from "bun:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/agents/conversation.ts";
import { AgentStore } from "../src/agents/store.ts";
import { learnedFixture } from "./learned-source-fixture.ts";

test("preference empty receipts reject stale complete prompt proof without a mutation", () => {
	const f = learnedFixture(),
		s = new ConversationStore(join(f.root, "c.sqlite"));
	const provenance = f.episode("r");
	f.revoke("r");
	try {
		expect(() =>
			s.observePreferences(
				"lina",
				"r",
				"r-user",
				"tea",
				[],
				() => f.source("r"),
				0,
				provenance,
			),
		).toThrow();
		expect(s.hasPreferenceReceipt("lina", "r")).toBe(false);
	} finally {
		s.close();
		f.close();
	}
});
test("qualified preferences retain raw history and full assistant ancestry across reopen", () => {
	const f = learnedFixture(),
		path = join(f.root, "c.sqlite");
	let s = new ConversationStore(path);
	try {
		f.episode("old");
		s.observePreferences(
			"lina",
			"old",
			"old-user",
			"tea",
			[{ dimension: "emoji", value: "none", quote: "tea" }],
			() => f.source("old"),
		);
		expect(s.modelPreferences("lina", f.lookup)).toMatchObject({
			revision: 1,
			items: [],
			sourceProofs: [],
		});
		const p = f.episode("r");
		s.observePreferences(
			"lina",
			"r",
			"r-user",
			"tea",
			[{ dimension: "emoji", value: "sparing", quote: "tea" }],
			() => f.source("r"),
			1,
			p,
		);
		s.close();
		s = new ConversationStore(path);
		expect(s.modelPreferences("lina", f.lookup).items[0]?.value).toBe(
			"sparing",
		);
		f.revoke("r");
		expect(s.hasPreferenceReceipt("lina", "r", f.lookup)).toBe(false);
		expect(s.hasPreferenceReceipt("lina", "r")).toBe(true);
		expect(s.modelPreferences("lina", f.lookup).items).toEqual([]);
		expect(s.getPreferences("lina").items[0]?.value).toBe("sparing");
		const db = new DatabaseSync(path);
		expect(
			db
				.prepare("SELECT count(*) n FROM conversation_preference_history")
				.get()?.["n"],
		).toBeGreaterThan(0);
		db.close();
	} finally {
		s.close();
		f.close();
	}
});
test("reflection empty receipt rejects stale or missing user proof before apply", () => {
	const f = learnedFixture(),
		s = new AgentStore(join(f.root, "a.sqlite"));
	s.create(f.profile);
	const provenance = f.episode("r");
	f.revoke("r");
	try {
		expect(() =>
			s.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: "r",
					sourceEntryIds: ["r-user"],
				},
				() => true,
				provenance,
			),
		).toThrow();
		expect(s.dynamics("lina").lastRequestId).toBeNull();
	} finally {
		s.close();
		f.close();
	}
});
test("ordinary reflection cannot confirm from legacy candidates and preserves raw snapshots", () => {
	const f = learnedFixture(),
		path = join(f.root, "a.sqlite");
	let s = new AgentStore(path);
	s.create(f.profile);
	const apply = (r: string, qualified = true) =>
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
			qualified ? f.episode(r) : undefined,
		);
	try {
		apply("legacy", false);
		expect(s.pendingGrowth("lina").interests).toEqual(["tea"]);
		expect(s.modelDynamics("lina", f.lookup).pendingGrowth.interests).toEqual(
			[],
		);
		apply("first");
		expect(s.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([]);
		expect(s.modelDynamics("lina", f.lookup).pendingGrowth.interests).toEqual([
			"tea",
		]);
		apply("second");
		expect(s.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([
			"tea",
		]);
		s.close();
		s = new AgentStore(path);
		f.revoke("first");
		expect(s.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([]);
		expect(s.dynamics("lina").interests).toEqual(["tea"]);
		apply("third");
		expect(s.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([]);
		apply("fourth");
		expect(s.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([
			"tea",
		]);
	} finally {
		s.close();
		f.close();
	}
});
test("reverting a qualified change cannot revive a revoked prior mood", () => {
	const f = learnedFixture(),
		s = new AgentStore(join(f.root, "a.sqlite"));
	s.create(f.profile);
	try {
		for (const r of ["first", "second"])
			s.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: s.dynamics("lina").revision,
					requestId: r,
					sourceEntryIds: [`${r}-user`],
					mood: { label: r, reason: "tea" },
				},
				() => true,
				f.episode(r),
			);
		const change = s.changes("lina")[0];
		if (!change) throw Error("fixture");
		f.revoke("first");
		s.revert("lina", change.id, 2);
		expect(s.dynamics("lina").mood?.label).toBe("first");
		expect(s.modelDynamics("lina", f.lookup).dynamics.mood).toBeNull();
	} finally {
		s.close();
		f.close();
	}
});

test("empty receipts survive reopen and exact ordinary revision changes invalidate reads and replay", () => {
	const f = learnedFixture(),
		ap = join(f.root, "agents.sqlite"),
		cp = join(f.root, "preferences.sqlite");
	let a = new AgentStore(ap),
		c = new ConversationStore(cp);
	a.create(f.profile);
	const p = f.episode("empty"),
		input = {
			profileRevision: 1,
			dynamicsRevision: 0,
			requestId: "empty",
			sourceEntryIds: ["empty-user"],
		};
	try {
		a.applyReflection("lina", input, () => true, p);
		c.observePreferences(
			"lina",
			"empty",
			"empty-user",
			"tea",
			[],
			() => f.source("empty"),
			0,
			p,
		);
		a.close();
		c.close();
		a = new AgentStore(ap);
		c = new ConversationStore(cp);
		expect(a.modelDynamics("lina", f.lookup).sourceProofs).toHaveLength(2);
		expect(c.hasPreferenceReceipt("lina", "empty", f.lookup)).toBe(true);
		const assistant = f.entries.get("empty-assistant");
		if (!assistant?.sourcePolicy) throw Error("fixture");
		assistant.requestStatus = "accepted";
		expect(a.modelDynamics("lina", f.lookup).dynamics.lastRequestId).toBeNull();
		expect(c.hasPreferenceReceipt("lina", "empty", f.lookup)).toBe(false);
		assistant.requestStatus = "settled";
		assistant.sourcePolicy.policyRevision++;
		expect(() => a.applyReflection("lina", input, () => true, p)).toThrow();
		expect(() =>
			c.observePreferences(
				"lina",
				"empty",
				"empty-user",
				"tea",
				[],
				() => f.source("empty"),
				0,
				p,
			),
		).toThrow();
		expect(c.hasPreferenceReceipt("lina", "empty")).toBe(true);
		expect(a.dynamics("lina").lastRequestId).toBe("empty");
	} finally {
		a.close();
		c.close();
		f.close();
	}
});

test("many legacy candidates cannot fill the qualified pending budget or confirm an ordinary proposal", () => {
	const f = learnedFixture(),
		a = new AgentStore(join(f.root, "agents.sqlite"));
	a.create(f.profile);
	try {
		for (let i = 0; i < 40; i++)
			a.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: `legacy-${i}`,
					sourceEntryIds: ["legacy"],
					interests: [`legacy-${i}`],
				},
				() => true,
			);
		a.applyReflection(
			"lina",
			{
				profileRevision: 1,
				dynamicsRevision: 0,
				requestId: "fresh",
				sourceEntryIds: ["fresh-user"],
				interests: ["tea"],
			},
			() => true,
			f.episode("fresh"),
		);
		expect(a.modelDynamics("lina", f.lookup).pendingGrowth.interests).toEqual([
			"tea",
		]);
		expect(a.modelDynamics("lina", f.lookup).dynamics.interests).toEqual([]);
		expect(a.pendingGrowth("lina").interests).toHaveLength(6);
	} finally {
		a.close();
		f.close();
	}
});

test("current provenance is checked again after an injected source callback and rolls back receipts", () => {
	const f = learnedFixture(),
		a = new AgentStore(join(f.root, "agents.sqlite")),
		c = new ConversationStore(join(f.root, "preferences.sqlite"));
	a.create(f.profile);
	try {
		const p = f.episode("agent");
		expect(() =>
			a.applyReflection(
				"lina",
				{
					profileRevision: 1,
					dynamicsRevision: 0,
					requestId: "agent",
					sourceEntryIds: ["agent-user"],
				},
				() => {
					f.revoke("agent");
					return true;
				},
				p,
			),
		).toThrow();
		const q = f.episode("preference");
		expect(() =>
			c.observePreferences(
				"lina",
				"preference",
				"preference-user",
				"tea",
				[],
				() => {
					f.revoke("preference");
					return f.source("preference");
				},
				0,
				q,
			),
		).toThrow();
		expect(a.dynamics("lina").lastRequestId).toBeNull();
		expect(c.hasPreferenceReceipt("lina", "preference")).toBe(false);
	} finally {
		a.close();
		c.close();
		f.close();
	}
});
