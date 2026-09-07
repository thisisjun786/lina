import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInput } from "../src/agents/types.ts";
import { DialogueStore } from "../src/onboarding/dialogue-store.ts";
import type { DialogueData } from "../src/onboarding/dialogue-types.ts";
import {
	MAX_NON_DONE_ROOMS,
	MAX_NON_OPENING_TURNS,
	MAX_SUMMARY_ITEM,
	MAX_SUMMARY_ITEMS,
	MAX_TRANSCRIPT_BYTES,
	MAX_TURN_REPLY,
	MAX_TURN_TEXT,
} from "../src/onboarding/dialogue-types.ts";
import { newUuid } from "../src/onboarding/helpers.ts";
import { MAX_CHAPTER_TEXT, MAX_USER_ANSWER } from "../src/onboarding/types.ts";

const profile = (id = "lina", patch: Partial<AgentInput> = {}): AgentInput => ({
	id,
	name: "Lina",
	role: "companion",
	personality: "curious",
	voice: "warm",
	profile: "core lore",
	appearance: "silver eyes",
	interests: ["tea"],
	avatarId: null,
	evolution: "adaptive",
	...patch,
});

const chapters = (text = ""): DialogueData["chapters"] => ({
	identity: text,
	values: text,
	temperament: text,
	interests: text,
	relationship: text,
	expression: text,
});

const data = (
	id = "lina",
	patch: Partial<DialogueData> = {},
): DialogueData => ({
	profile: profile(id),
	chapters: chapters(),
	user: {},
	summary: [],
	ready: false,
	...patch,
});

describe("onboarding dialogue store", () => {
	let dir: string;
	let path: string;
	let store: DialogueStore;
	const now = { t: 1_700_000_000_000 };

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-dialogue-"));
		path = join(dir, "introductions.sqlite");
		store = new DialogueStore(path, () => now.t);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates, gets, lists latest and resumes the same non-done room", () => {
		const created = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		expect(created.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(created.status).toBe("active");
		expect(created.revision).toBe(0);
		expect(store.get(created.id)).toEqual(created);
		expect(store.latest("lina")?.id).toBe(created.id);
		const resumed = store.create({
			agentId: "lina",
			kind: "user",
			mode: "thoughtful",
			draftId: null,
			data: data("lina", { ready: true }),
		});
		expect(resumed.id).toBe(created.id);
		expect(resumed.mode).toBe("fast");
		expect(resumed.data.ready).toBe(false);
		now.t += 1;
		const persona = store.create({
			agentId: "lina",
			kind: "persona",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		expect(persona.id).not.toBe(created.id);
		expect(store.latest("lina")?.id).toBe(persona.id);
		expect(store.get(created.id)?.kind).toBe("user");
	});

	it("picks the later same-clock room for latest, not UUID sort", () => {
		const first = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const applying = store.patch(first.id, first.revision, {
			status: "applying",
			finalization: { applyId: "a" },
		});
		store.patch(applying.id, applying.revision, { status: "done" });
		const second = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		expect(second.id).not.toBe(first.id);
		expect(second.createdAt).toBe(first.createdAt);
		expect(store.latest("lina")?.id).toBe(second.id);
		store.close();
		store = new DialogueStore(path, () => now.t);
		expect(store.latest("lina")?.id).toBe(second.id);
	});

	it("rejects profile id mismatch and unknown create fields", () => {
		expect(() =>
			store.create({
				agentId: "lina",
				kind: "user",
				mode: "fast",
				draftId: null,
				data: data("kai"),
			}),
		).toThrow(/mismatch|agent/i);
		expect(() =>
			store.create({
				agentId: "lina",
				kind: "user",
				mode: "fast",
				draftId: null,
				data: data(),
				extra: true,
			} as never),
		).toThrow(/unknown|create/i);
	});

	it("caps 16 non-done rooms and keeps completed rooms", () => {
		const rooms = [];
		for (let i = 0; i < MAX_NON_DONE_ROOMS; i++) {
			const id = `agent${String(i)}`;
			rooms.push(
				store.create({
					agentId: id,
					kind: "user",
					mode: "fast",
					draftId: null,
					data: data(id),
				}),
			);
		}
		expect(() =>
			store.create({
				agentId: "overflow",
				kind: "user",
				mode: "fast",
				draftId: null,
				data: data("overflow"),
			}),
		).toThrow(/capacity/i);
		const first = rooms[0];
		if (!first) throw new Error("expected room");
		const applying = store.patch(first.id, first.revision, {
			status: "applying",
			finalization: { applyId: "a" },
		});
		store.patch(applying.id, applying.revision, { status: "done" });
		const extra = store.create({
			agentId: "overflow",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data("overflow"),
		});
		expect(extra.agentId).toBe("overflow");
		expect(store.get(first.id)?.status).toBe("done");
	});

	it("persists user text before commit without bumping revision", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		const begun = store.begin(room.id, room.revision, request, "안녕");
		expect(begun.replay).toBe(false);
		expect(begun.room.revision).toBe(0);
		expect(begun.turn.status).toBe("pending");
		expect(begun.turn.text).toBe("안녕");
		expect(begun.turn.reply).toBeNull();
		expect(store.get(room.id)?.revision).toBe(0);
		const turns = store.turns(room.id);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.text).toBe("안녕");
	});

	it("replays the same request text, conflicts on a different text, and isolates pending calls", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		const first = store.begin(room.id, 0, request, "안녕");
		const inflight = store.begin(room.id, 0, request, "안녕");
		expect(inflight.replay).toBe(true);
		expect(inflight.turn.id).toBe(first.turn.id);
		expect(() => store.begin(room.id, 0, newUuid(), "다른")).toThrow(
			/pending|conflict/i,
		);
		expect(() => store.begin(room.id, 0, request, "다른")).toThrow(/conflict/i);
		const committed = store.commit(
			room.id,
			request,
			0,
			"반가워요",
			data("lina", {
				user: { address: "예시" },
				summary: ["이름은 예시"],
				ready: false,
			}),
		);
		expect(committed.revision).toBe(1);
		expect(committed.data.user).toEqual({ address: "예시" });
		const replay = store.begin(room.id, 0, request, "안녕");
		expect(replay.replay).toBe(true);
		expect(replay.turn.status).toBe("done");
		expect(replay.turn.reply).toBe("반가워요");
		expect(replay.room.revision).toBe(1);
		const again = store.commit(room.id, request, 0, "반가워요", committed.data);
		expect(again.revision).toBe(1);
	});

	it("fails without bumping revision and retries the same text on the current revision", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		store.begin(room.id, 0, request, "질문");
		store.fail(room.id, request, "cancelled");
		const failed = store.turns(room.id)[0];
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toBe("cancelled");
		expect(failed?.text).toBe("질문");
		expect(store.get(room.id)?.revision).toBe(0);
		expect(() => store.begin(room.id, 1, request, "질문")).toThrow(
			/revision|stale/i,
		);
		const retried = store.begin(room.id, 0, request, "질문");
		expect(retried.replay).toBe(false);
		expect(retried.turn.status).toBe("pending");
		expect(retried.turn.attempts).toBe(2);
		expect(retried.turn.error).toBeNull();
		expect(retried.turn.requestId).toBe(request);
		expect(retried.room.revision).toBe(0);
	});

	it("commits only the pending matching request at the current revision", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		store.begin(room.id, 0, request, "안녕");
		expect(() => store.commit(room.id, request, 1, "답", data())).toThrow(
			/revision|stale/i,
		);
		expect(store.get(room.id)?.revision).toBe(0);
		const next = data("lina", { summary: ["요약"], ready: true });
		const committed = store.commit(room.id, request, 0, "답변입니다", next);
		expect(committed.revision).toBe(1);
		expect(committed.data.ready).toBe(true);
		const turn = store.turns(room.id)[0];
		expect(turn?.status).toBe("done");
		expect(turn?.reply).toBe("답변입니다");
		expect(turn?.summary).toEqual(["요약"]);
		expect(turn?.repliedAt).toBe(now.t);
	});

	it("patches CAS status without writes while pending and freezes finalization", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		store.begin(room.id, 0, request, "안녕");
		expect(() => store.patch(room.id, 0, { mode: "thoughtful" })).toThrow(
			/pending/i,
		);
		store.fail(room.id, request, "stop");
		expect(() => store.patch(room.id, 1, { mode: "thoughtful" })).toThrow(
			/revision|stale/i,
		);
		const applying = store.patch(room.id, 0, {
			status: "applying",
			finalization: { frozen: true },
		});
		expect(applying.status).toBe("applying");
		expect(applying.finalization).toEqual({ frozen: true });
		expect(() =>
			store.patch(applying.id, applying.revision, {
				finalization: { frozen: false },
			}),
		).toThrow(/finalization/i);
		expect(() =>
			store.begin(applying.id, applying.revision, newUuid(), "x"),
		).toThrow(/active/i);
		const choices = store.patch(applying.id, applying.revision, {
			status: "choices",
		});
		expect(choices.status).toBe("choices");
		expect(choices.finalization).toEqual({ frozen: true });
		const selected = store.patch(choices.id, choices.revision, {
			status: "applying",
		});
		expect(selected.status).toBe("applying");
		expect(selected.finalization).toEqual({ frozen: true });
		const done = store.patch(selected.id, selected.revision, {
			status: "done",
		});
		expect(done.status).toBe("done");
		expect(() => store.patch(done.id, done.revision, { mode: "fast" })).toThrow(
			/done/i,
		);
	});

	it("allows an opening null turn only first and forbids blank text", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const opening = newUuid();
		const begun = store.begin(room.id, 0, opening, null);
		expect(begun.turn.text).toBeNull();
		store.commit(room.id, opening, 0, "처음 뵙겠습니다", data());
		expect(() => store.begin(room.id, 1, newUuid(), null)).toThrow(
			/opening|first/i,
		);
		expect(() => store.begin(room.id, 1, newUuid(), "   ")).toThrow(/blank/i);
	});

	it("keeps rooms isolated across agents", () => {
		const lina = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data("lina"),
		});
		const kai = store.create({
			agentId: "kai",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data("kai"),
		});
		const req = newUuid();
		store.begin(lina.id, 0, req, "리나");
		store.fail(lina.id, req, "x");
		expect(store.get(kai.id)?.revision).toBe(0);
		expect(store.turns(kai.id)).toEqual([]);
		expect(store.latest("kai")?.id).toBe(kai.id);
	});

	it("preserves raw text on restart and recovers pending turns as failed", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const doneReq = newUuid();
		store.begin(room.id, 0, doneReq, "보존");
		store.commit(
			room.id,
			doneReq,
			0,
			"기억합니다",
			data("lina", {
				user: { address: "예시" },
			}),
		);
		const pendingReq = newUuid();
		store.begin(room.id, 1, pendingReq, "이어서");
		store.close();
		store = new DialogueStore(path, () => now.t);
		const restored = store.get(room.id);
		expect(restored?.revision).toBe(1);
		expect(restored?.data.user).toEqual({ address: "예시" });
		const turns = store.turns(room.id);
		const interrupted = turns[1];
		if (!interrupted) throw new Error("expected interrupted turn");
		expect(turns[0]?.text).toBe("보존");
		expect(turns[0]?.reply).toBe("기억합니다");
		expect(interrupted.text).toBe("이어서");
		expect(interrupted.status).toBe("failed");
		expect(interrupted.error).toMatch(/interrupted/i);
		expect(interrupted.seq).toBe(2);
		expect(turns[0]?.requestId).toBe(doneReq);
		expect(interrupted.requestId).toBe(pendingReq);
		const retried = store.begin(room.id, 1, pendingReq, "이어서");
		expect(retried.replay).toBe(false);
		expect(retried.turn.requestId).toBe(pendingReq);
		expect(retried.turn.id).toBe(interrupted.id);
	});

	it("keeps :memory: off the filesystem and creates a 0600 database file", () => {
		const mem = new DialogueStore(":memory:");
		try {
			expect(mem.latest("lina")).toBeUndefined();
			expect(existsSync(":memory:")).toBe(false);
			expect(existsSync(join(process.cwd(), ":memory:"))).toBe(false);
		} finally {
			mem.close();
		}
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("rejects a foreign schema without adopting it", () => {
		const foreign = join(dir, "foreign.sqlite");
		const db = new DatabaseSync(foreign);
		db.exec("CREATE TABLE foo (id INTEGER)");
		db.close();
		expect(() => new DialogueStore(foreign)).toThrow(/foreign|schema/i);
		const columns = join(dir, "wrong-columns.sqlite");
		const other = new DatabaseSync(columns);
		other.exec(
			"CREATE TABLE dialogue_rooms (id TEXT PRIMARY KEY, extra INTEGER) STRICT",
		);
		other.close();
		expect(() => new DialogueStore(columns)).toThrow(/schema/i);
	});

	it("enforces text, reply, chapter, user, summary and turn caps", () => {
		const room = store.create({
			agentId: "lina",
			kind: "user",
			mode: "fast",
			draftId: null,
			data: data(),
		});
		const request = newUuid();
		expect(() =>
			store.begin(room.id, 0, request, "x".repeat(MAX_TURN_TEXT + 1)),
		).toThrow(/text|invalid/i);
		store.begin(room.id, 0, request, "ok");
		expect(() =>
			store.commit(room.id, request, 0, "y".repeat(MAX_TURN_REPLY + 1), data()),
		).toThrow(/reply|invalid/i);
		expect(() =>
			store.commit(
				room.id,
				request,
				0,
				"yes",
				data("lina", {
					chapters: chapters("c".repeat(MAX_CHAPTER_TEXT + 1)),
				}),
			),
		).toThrow(/chapter/i);
		expect(() =>
			store.commit(
				room.id,
				request,
				0,
				"yes",
				data("lina", {
					user: { address: "u".repeat(MAX_USER_ANSWER + 1) },
				}),
			),
		).toThrow(/address|user|invalid/i);
		expect(() =>
			store.commit(
				room.id,
				request,
				0,
				"yes",
				data("lina", {
					summary: Array.from({ length: MAX_SUMMARY_ITEMS + 1 }, () => "s"),
				}),
			),
		).toThrow(/summary/i);
		expect(() =>
			store.commit(
				room.id,
				request,
				0,
				"yes",
				data("lina", {
					summary: ["s".repeat(MAX_SUMMARY_ITEM + 1)],
				}),
			),
		).toThrow(/summary/i);
		store.fail(room.id, request, "stop");
		let current = 0;
		for (let i = 0; i < MAX_NON_OPENING_TURNS - 1; i++) {
			const id = newUuid();
			store.begin(room.id, current, id, `t${String(i)}`);
			store.commit(room.id, id, current, `r${String(i)}`, data());
			current += 1;
		}
		expect(() => store.begin(room.id, current, newUuid(), "overflow")).toThrow(
			/capacity/i,
		);
		const payload = JSON.stringify(store.turns(room.id));
		expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(
			2 * 1024 * 1024,
		);
	});

	it("enforces the UTF-8 transcript budget before a new turn", () => {
		const packed = new DialogueStore(join(dir, "budget.sqlite"), () => now.t);
		try {
			const room = packed.create({
				agentId: "lina",
				kind: "user",
				mode: "fast",
				draftId: null,
				data: data(),
			});
			const chunk = "가".repeat(4000);
			let revision = 0;
			let blocked = false;
			for (let i = 0; i < 50; i++) {
				const id = newUuid();
				try {
					packed.begin(room.id, revision, id, chunk);
					packed.commit(room.id, id, revision, "답", data());
					revision += 1;
				} catch (error) {
					expect(String(error)).toMatch(/budget|bytes/i);
					blocked = true;
					break;
				}
			}
			expect(blocked).toBe(true);
			expect(MAX_TRANSCRIPT_BYTES).toBe(500000);
		} finally {
			packed.close();
		}
	});
});
