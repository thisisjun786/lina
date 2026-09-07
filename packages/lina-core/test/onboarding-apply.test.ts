import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentStore } from "../src/agents/store.ts";
import type { AgentInput } from "../src/agents/types.ts";
import { emptyUserAnswers, newUuid } from "../src/onboarding/helpers.ts";
import { OnboardingStore } from "../src/onboarding/store.ts";
import type { OnboardingBoundary } from "../src/onboarding/types.ts";

const profile = (patch: Partial<AgentInput> = {}): AgentInput => ({
	id: "kai",
	name: "Kai",
	role: "companion",
	personality: "curious",
	voice: "warm",
	profile: "core lore",
	appearance: "silver eyes",
	interests: ["music"],
	avatarId: null,
	evolution: "adaptive",
	...patch,
});

const OLD_AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, personality TEXT NOT NULL, voice TEXT NOT NULL, profile TEXT NOT NULL, appearance TEXT NOT NULL, interests TEXT NOT NULL, avatar_id TEXT, evolution TEXT NOT NULL, revision INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS agent_dynamics (agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id), revision INTEGER NOT NULL, mood TEXT, interests TEXT NOT NULL, preferences TEXT NOT NULL, relationship TEXT NOT NULL, last_request_id TEXT) STRICT;
CREATE TABLE IF NOT EXISTS agent_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, created_at TEXT NOT NULL, source_entry_ids TEXT NOT NULL, summary TEXT NOT NULL, before_state TEXT, after_state TEXT, target_change_id INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS agent_receipts (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), request_id TEXT NOT NULL, PRIMARY KEY(agent_id, request_id)) STRICT;
CREATE TABLE IF NOT EXISTS agent_candidates (agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL, value TEXT NOT NULL, request_ids TEXT NOT NULL, PRIMARY KEY(agent_id, kind, value)) STRICT;
`;

describe("applyAuthored receipts", () => {
	let dir: string;
	let agents: AgentStore;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-authored-"));
		agents = new AgentStore(join(dir, "agents.sqlite"));
	});
	afterEach(() => {
		agents.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates, updates, and replays the same receipt without a nested transaction", () => {
		const receipt = newUuid();
		const created = agents.applyAuthored(profile(), null, receipt);
		expect(created.revision).toBe(1);
		expect(agents.applyAuthored(profile(), null, receipt)).toEqual(created);
		expect(() =>
			agents.applyAuthored(profile({ name: "Other" }), null, receipt),
		).toThrow(/receipt|conflict|hash/i);
		const updated = agents.applyAuthored(
			profile({ voice: "quiet" }),
			1,
			newUuid(),
		);
		expect(updated).toMatchObject({ voice: "quiet", revision: 2 });
		const later = agents.update("kai", 2, { name: "Edited" });
		expect(later.revision).toBe(3);
		const replayed = agents.applyAuthored(profile(), null, receipt);
		expect(replayed).toEqual(created);
		expect(agents.get("kai")?.revision).toBe(3);
		expect(agents.get("kai")?.name).toBe("Edited");
	});

	it("opens an old agent schema and adds authored receipts", () => {
		agents.close();
		const path = join(dir, "legacy.sqlite");
		const db = new DatabaseSync(path);
		db.exec("PRAGMA foreign_keys = ON");
		for (const sql of OLD_AGENT_SCHEMA.split(";")) if (sql.trim()) db.exec(sql);
		db.close();
		const reopened = new AgentStore(path);
		const made = reopened.applyAuthored(
			profile({ id: "nova" }),
			null,
			newUuid(),
		);
		expect(made.id).toBe("nova");
		expect(made.revision).toBe(1);
		reopened.close();
	});
});

describe("onboarding apply saga", () => {
	let dir: string;
	let store: OnboardingStore;
	let agents: AgentStore;
	let fail: OnboardingBoundary | undefined;
	const now = { t: 1_700_000_000_000 };
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-onboarding-apply-"));
		fail = undefined;
		store = new OnboardingStore(join(dir, "onboarding.sqlite"), {
			now: () => now.t,
			onBoundary: (name) => {
				if (fail === name) throw new Error(`crash:${name}`);
			},
		});
		agents = new AgentStore(join(dir, "agents.sqlite"), () => now.t);
	});
	afterEach(() => {
		store.close();
		agents.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function readyDraft() {
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "fast" },
			{ agents, presets: [], existingCount: agents.list().length },
		);
		let current = draft;
		for (const id of [
			"identity",
			"values",
			"temperament",
			"interests",
			"relationship",
			"expression",
		] as const) {
			current = store.patchDraft(current.id, {
				revision: current.revision,
				chapter: {
					id,
					text: id === "identity" ? "기록가" : "",
					status: id === "identity" ? "confirmed" : "deferred",
				},
			});
		}
		store.saveUser(
			{
				revision: 0,
				answers: { ...emptyUserAnswers(), address: "예시" },
				sharedAgentIds: [],
				confirm: true,
			},
			new Set(),
		);
		return current;
	}

	it("recovers after profile commit and will not overwrite a newer editor revision", () => {
		const draft = readyDraft();
		fail = "profile-applied";
		expect(() =>
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: true, userRevision: 1 },
				agents,
			),
		).toThrow(/crash:profile-applied/);
		expect(agents.get(draft.profile.id)?.revision).toBe(1);
		expect(store.authoredContextFor(draft.profile.id, 1)).toBe("");
		fail = undefined;
		const applied = store.applyDraft(
			draft.id,
			{ revision: draft.revision, shareUser: true, userRevision: 1 },
			agents,
		);
		expect(applied.agentId).toBe(draft.profile.id);
		expect(store.authoredContextFor(applied.agentId, 1)).toContain("기록가");
		expect(store.userContextFor(applied.agentId)).toContain("예시");
		expect(
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: true, userRevision: 1 },
				agents,
			).agentId,
		).toBe(applied.agentId);
		agents.update(applied.agentId, 1, { name: "수동 수정" });
		expect(store.authoredContextFor(applied.agentId, 2)).toBe("");
		fail = "profile-applied";
		const again = store.createDraft(
			{ targetAgentId: applied.agentId, mode: "fast" },
			{ agents, presets: [], existingCount: agents.list().length },
		);
		let current = again;
		for (const id of [
			"identity",
			"values",
			"temperament",
			"interests",
			"relationship",
			"expression",
		] as const) {
			current = store.patchDraft(current.id, {
				revision: current.revision,
				chapter: { id, text: "새 초안", status: "deferred" },
			});
		}
		expect(() =>
			store.applyDraft(
				current.id,
				{ revision: current.revision, shareUser: false, userRevision: 2 },
				agents,
			),
		).toThrow(/crash:profile-applied/);
		fail = undefined;
		agents.update(applied.agentId, agents.get(applied.agentId)?.revision ?? 0, {
			voice: "newer",
		});
		expect(() =>
			store.applyDraft(
				current.id,
				{ revision: current.revision, shareUser: false, userRevision: 2 },
				agents,
			),
		).toThrow(/conflict|stale|revision/i);
		expect(agents.get(applied.agentId)?.voice).toBe("newer");
		const unlocked = store.patchDraft(current.id, {
			revision: current.revision,
			chapter: { id: "identity", text: "다시 작성", status: "proposed" },
		});
		expect(unlocked.chapters.identity.status).toBe("proposed");
	});

	it("binds the created agent on the draft and rejects a mismatched share retry", () => {
		const draft = readyDraft();
		const applied = store.applyDraft(
			draft.id,
			{ revision: draft.revision, shareUser: true, userRevision: 1 },
			agents,
		);
		expect(store.getDraft(draft.id)?.targetAgentId).toBe(applied.agentId);
		expect(() =>
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: false, userRevision: 1 },
				agents,
			),
		).toThrow(/shareUser/i);
		expect(
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: true, userRevision: 1 },
				agents,
			).agentId,
		).toBe(applied.agentId);
		const refined = store.createDraft(
			{ targetAgentId: applied.agentId, mode: "thoughtful" },
			{ agents, presets: [], existingCount: agents.list().length },
		);
		expect(refined.chapters.identity.status).toBe("confirmed");
		expect(refined.chapters.identity.text).toBe("기록가");
	});

	it("imports stale authored chapters as proposed after an old editor change", () => {
		const draft = readyDraft();
		const applied = store.applyDraft(
			draft.id,
			{ revision: draft.revision, shareUser: false, userRevision: 1 },
			agents,
		);
		agents.update(applied.agentId, 1, { name: "수동 수정" });
		const imported = store.createDraft(
			{ targetAgentId: applied.agentId, mode: "thoughtful" },
			{ agents, presets: [], existingCount: agents.list().length },
		);
		expect(imported.staleExtension).toBe(true);
		expect(imported.chapters.identity.status).toBe("proposed");
		expect(imported.chapters.identity.text).toBe("기록가");
		expect(imported.chapters.values.status).toBe("deferred");
	});

	it("does not mutate the profile when a prepared retry sees a newer user revision", () => {
		const draft = readyDraft();
		fail = "intent-prepared";
		expect(() =>
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: true, userRevision: 1 },
				agents,
			),
		).toThrow(/crash:intent-prepared/);
		expect(agents.get(draft.profile.id)).toBeUndefined();
		store.saveUser(
			{
				revision: 1,
				answers: { ...emptyUserAnswers(), address: "예시" },
				sharedAgentIds: [],
				confirm: false,
			},
			new Set(),
		);
		fail = undefined;
		expect(() =>
			store.applyDraft(
				draft.id,
				{ revision: draft.revision, shareUser: true, userRevision: 1 },
				agents,
			),
		).toThrow(/stale user revision/);
		expect(agents.get(draft.profile.id)).toBeUndefined();
		const applied = store.applyDraft(
			draft.id,
			{ revision: draft.revision, shareUser: true, userRevision: 2 },
			agents,
		);
		expect(applied.agentId).toBe(draft.profile.id);
	});

	it("revokes prior introduction sharing when apply sets shareUser false", () => {
		const draft = readyDraft();
		const applied = store.applyDraft(
			draft.id,
			{ revision: draft.revision, shareUser: true, userRevision: 1 },
			agents,
		);
		expect(store.userContextFor(applied.agentId)).toContain("예시");
		const next = store.createDraft(
			{ targetAgentId: applied.agentId, mode: "fast" },
			{ agents, presets: [], existingCount: agents.list().length },
		);
		store.applyDraft(
			next.id,
			{
				revision: next.revision,
				shareUser: false,
				userRevision: store.user().revision,
			},
			agents,
		);
		expect(store.userContextFor(applied.agentId)).toBe("");
		expect(store.user().sharedAgentIds).not.toContain(applied.agentId);
	});
});
