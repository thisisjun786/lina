import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/agents/store.ts";
import type { AgentInput } from "../src/agents/types.ts";
import { emptyUserAnswers, newUuid } from "../src/onboarding/helpers.ts";
import { OnboardingStore } from "../src/onboarding/store.ts";
import type { UserAnswers } from "../src/onboarding/types.ts";
import {
	CHAPTER_IDS,
	MAX_DRAFT_BYTES,
	MAX_DRAFTS,
	UNSPECIFIED,
} from "../src/onboarding/types.ts";

const input = (patch: Partial<AgentInput> = {}): AgentInput => ({
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

const answers = (patch: Partial<UserAnswers> = {}): UserAnswers => ({
	...emptyUserAnswers(),
	...patch,
});

describe("onboarding store", () => {
	let dir: string;
	let store: OnboardingStore;
	let agents: AgentStore;
	const now = { t: 1_700_000_000_000 };
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lina-onboarding-"));
		store = new OnboardingStore(join(dir, "onboarding.sqlite"), {
			now: () => now.t,
		});
		agents = new AgentStore(join(dir, "agents.sqlite"), () => now.t);
	});
	afterEach(() => {
		store.close();
		agents.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts with empty user state and no inferred profile", () => {
		const user = store.user();
		expect(user).toEqual({
			revision: 0,
			draft: emptyUserAnswers(),
			confirmed: null,
			sharedAgentIds: [],
		});
		expect(store.snapshot().drafts).toEqual([]);
		expect(store.userContextFor("lina")).toBe("");
		expect(store.authoredContextFor("lina", 1)).toBe("");
	});

	it("rejects unknown nested chapter fields without mutating the draft", () => {
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "fast" },
			{ agents, presets: [], existingCount: 0 },
		);
		expect(() =>
			store.patchDraft(draft.id, {
				revision: draft.revision,
				chapter: {
					id: "identity",
					text: "기록가",
					status: "confirmed",
					hiddenPermission: true,
				},
			} as never),
		).toThrow(/unknown|fields/i);
		expect(store.getDraft(draft.id)?.revision).toBe(draft.revision);
	});

	it("opens a reviewable current draft after a concurrent editor change without deleting the older draft", () => {
		agents.create(input());
		const deps = { agents, presets: [], existingCount: 1 };
		let old = store.createDraft(
			{ targetAgentId: "kai", mode: "thoughtful" },
			deps,
		);
		old = store.addAnswer(old.id, {
			revision: old.revision,
			chapter: "identity",
			answerId: newUuid(),
			text: "별을 관찰하는 기록가",
		});
		old = store.patchDraft(old.id, {
			revision: old.revision,
			chapter: { id: "identity", text: "관찰 기록가다.", status: "confirmed" },
		});
		agents.update("kai", 1, { name: "현재 이름" });
		const fresh = store.createDraft(
			{ targetAgentId: "kai", mode: "thoughtful" },
			deps,
		);
		expect(fresh.id).not.toBe(old.id);
		expect(fresh.profile.name).toBe("현재 이름");
		expect(fresh.baseRevision).toBe(2);
		expect(fresh.chapters.identity.text).toBe("관찰 기록가다.");
		expect(fresh.chapters.identity.status).toBe("proposed");
		expect(fresh.chapters.identity.answers).toEqual(
			old.chapters.identity.answers,
		);
		expect(store.getDraft(old.id)).toEqual(old);
	});

	it("saves draft without confirming and confirms without blanks", () => {
		const draft = store.saveUser(
			{
				revision: 0,
				answers: answers({ address: "예시", currentFocus: "" }),
				sharedAgentIds: [],
				confirm: false,
			},
			new Set(),
		);
		expect(draft.revision).toBe(1);
		expect(draft.confirmed).toBeNull();
		expect(draft.draft.address).toBe("예시");
		const confirmed = store.saveUser(
			{
				revision: 1,
				answers: answers({
					address: "예시",
					context: "  ",
					currentFocus: "이사",
				}),
				sharedAgentIds: [],
				confirm: true,
			},
			new Set(),
		);
		expect(confirmed.confirmed?.answers.address).toBe("예시");
		expect(confirmed.confirmed?.answers.context).toBe("");
		expect(confirmed.confirmed?.answers.currentFocus).toBe("이사");
		expect(confirmed.confirmed?.confirmedAt).toBe(now.t);
		expect(confirmed.confirmed?.currentFocusExpiresAt).toBe(
			now.t + 7 * 24 * 60 * 60 * 1000,
		);
		expect(() =>
			store.saveUser(
				{
					revision: 1,
					answers: answers(),
					sharedAgentIds: [],
					confirm: false,
				},
				new Set(),
			),
		).toThrow(/revision|stale/i);
	});

	it("shares only existing agent ids and revokes injection", () => {
		agents.create(input({ id: "kai" }));
		expect(() =>
			store.saveUser(
				{
					revision: 0,
					answers: answers({ address: "예시" }),
					sharedAgentIds: ["missing"],
					confirm: true,
				},
				new Set(agents.list().map((a) => a.id)),
			),
		).toThrow(/unknown|agent/i);
		store.saveUser(
			{
				revision: 0,
				answers: answers({ address: "예시" }),
				sharedAgentIds: ["kai"],
				confirm: true,
			},
			new Set(["kai"]),
		);
		expect(store.userContextFor("kai")).toContain('"address":"예시"');
		expect(store.userContextFor("lina")).toBe("");
		store.saveUser(
			{
				revision: 1,
				answers: answers({ address: "예시" }),
				sharedAgentIds: [],
				confirm: false,
			},
			new Set(["kai"]),
		);
		expect(store.userContextFor("kai")).toBe("");
		expect(store.user().confirmed?.answers.address).toBe("예시");
	});

	it("creates new, preset and existing drafts without inventing user answers", () => {
		const created = agents.create(input());
		const preset = input({
			id: "lina",
			name: "리나",
			interests: ["tea"],
			personality: "p".repeat(40),
		});
		const fresh = store.createDraft(
			{ targetAgentId: null, mode: "fast" },
			{ agents, presets: [preset], existingCount: agents.list().length },
		);
		expect(fresh.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(fresh.profile.id.startsWith("agent-")).toBe(true);
		expect(fresh.profile.evolution).toBe("adaptive");
		expect(fresh.profile.profile).toBe(UNSPECIFIED);
		expect(fresh.chapters.identity.status).toBe("untouched");
		const fromPreset = store.createDraft(
			{ targetAgentId: null, presetId: "lina", mode: "thoughtful" },
			{ agents, presets: [preset], existingCount: agents.list().length },
		);
		expect(fromPreset.profile.name).toBe("리나");
		expect(fromPreset.profile.interests).toEqual(["tea"]);
		expect(fromPreset.profile.id).not.toBe("lina");
		expect(fromPreset.chapters.values.status).toBe("untouched");
		const imported = store.createDraft(
			{ targetAgentId: "kai", mode: "thoughtful" },
			{ agents, presets: [preset], existingCount: agents.list().length },
		);
		const { revision: _r, ...verbatim } = created;
		expect(imported.profile).toEqual(verbatim);
		expect(imported.targetAgentId).toBe("kai");
		expect(imported.baseRevision).toBe(1);
		expect(
			CHAPTER_IDS.every((id) => imported.chapters[id].status === "untouched"),
		).toBe(true);
	});

	it("keeps raw answers when chapter text is authored", () => {
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "thoughtful" },
			{ agents, presets: [], existingCount: 0 },
		);
		const answerId = newUuid();
		const answered = store.addAnswer(draft.id, {
			revision: draft.revision,
			chapter: "identity",
			text: "차분한데 좋아하는 얘기엔 말 많아지는 애",
			answerId,
		});
		expect(answered.chapters.identity.answers[0]).toEqual({
			id: answerId,
			text: "차분한데 좋아하는 얘기엔 말 많아지는 애",
		});
		const same = store.addAnswer(draft.id, {
			revision: 0,
			chapter: "identity",
			text: "차분한데 좋아하는 얘기엔 말 많아지는 애",
			answerId,
		});
		expect(same.revision).toBe(answered.revision);
		expect(() =>
			store.addAnswer(draft.id, {
				revision: answered.revision,
				chapter: "identity",
				text: "다른 내용",
				answerId,
			}),
		).toThrow(/answer/i);
		const authored = store.patchDraft(draft.id, {
			revision: answered.revision,
			chapter: {
				id: "identity",
				text: "평소엔 여유롭고 좋아하는 주제에선 들뜬다",
				status: "confirmed",
			},
		});
		expect(authored.chapters.identity.status).toBe("confirmed");
		expect(authored.chapters.identity.proposal).toBeNull();
		expect(authored.chapters.identity.answers[0]?.text).toBe(
			"차분한데 좋아하는 얘기엔 말 많아지는 애",
		);
		const switched = store.patchDraft(draft.id, {
			revision: authored.revision,
			mode: "fast",
		});
		expect(switched.mode).toBe("fast");
		expect(switched.chapters.identity.answers).toHaveLength(1);
		expect(() =>
			store.patchDraft(draft.id, { revision: switched.revision }),
		).toThrow(/empty|patch/i);
	});

	it("caps automatic follow-ups and keeps deepen from spending the allowance", () => {
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "thoughtful" },
			{ agents, presets: [], existingCount: 0 },
		);
		const answerId = newUuid();
		const answered = store.addAnswer(draft.id, {
			revision: draft.revision,
			chapter: "values",
			text: "정직이 먼저다",
			answerId,
		});
		const first = store.commitInterview(
			draft.id,
			answered.revision,
			"values",
			false,
			{
				text: "정직을 우선한다",
				question: "어떤 장면에서요?",
				sourceIds: [answerId],
			},
		);
		expect(first.chapters.values.followups).toBe(1);
		expect(first.chapters.values.status).toBe("proposed");
		const second = store.commitInterview(
			draft.id,
			first.revision,
			"values",
			false,
			{
				text: "약속 장면",
				question: "",
				sourceIds: [answerId],
			},
		);
		expect(second.chapters.values.followups).toBe(2);
		const capped = store.prepareInterview(
			draft.id,
			second.revision,
			"values",
			false,
		);
		expect(capped.kind).toBe("capped");
		if (capped.kind !== "capped") throw new Error("expected cap");
		expect(capped.question).toBe("");
		expect(capped.proposal).toBe("약속 장면");
		const deepened = store.commitInterview(
			draft.id,
			second.revision,
			"values",
			true,
			{
				text: "자발적 심화",
				question: "더 말해볼까요?",
				sourceIds: [answerId],
			},
		);
		expect(deepened.chapters.values.followups).toBe(2);
		expect(() =>
			store.commitInterview(draft.id, second.revision, "values", false, {
				text: "중복",
				question: "x",
				sourceIds: [answerId],
			}),
		).toThrow(/revision|stale|conflict/i);
		expect(() =>
			store.commitInterview(draft.id, deepened.revision, "values", false, {
				text: "",
				question: "x",
				sourceIds: [answerId],
			}),
		).toThrow(/blank|proposal/i);
		expect(store.getDraft(draft.id)?.chapters.values.followups).toBe(2);
	});

	it("copies proposal text for preview and invalidates confirmation on a new answer", () => {
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "thoughtful" },
			{ agents, presets: [], existingCount: 0 },
		);
		const firstId = newUuid();
		const answered = store.addAnswer(draft.id, {
			revision: draft.revision,
			chapter: "expression",
			text: "짧게 말한다",
			answerId: firstId,
		});
		const proposed = store.commitInterview(
			draft.id,
			answered.revision,
			"expression",
			false,
			{
				text: "말은 짧고 정확하다.",
				question: "어떤 상황에서 길어지나요?",
				sourceIds: [firstId],
			},
		);
		expect(proposed.chapters.expression.status).toBe("proposed");
		expect(proposed.chapters.expression.text).toBe("말은 짧고 정확하다.");
		const confirmed = store.patchDraft(draft.id, {
			revision: proposed.revision,
			chapter: {
				id: "expression",
				text: "말은 짧고 정확하다.",
				status: "confirmed",
			},
		});
		expect(confirmed.chapters.expression.status).toBe("confirmed");
		const nextId = newUuid();
		const after = store.addAnswer(draft.id, {
			revision: confirmed.revision,
			chapter: "expression",
			text: "좋아하는 얘기엔 말이 많아진다",
			answerId: nextId,
		});
		expect(after.chapters.expression.status).toBe("proposed");
		expect(after.chapters.expression.proposal).toBeNull();
		expect(after.chapters.expression.answers).toHaveLength(2);
		const pending = store.patchDraft(draft.id, {
			revision: after.revision,
			chapter: {
				id: "expression",
				text: "평소엔 짧고 좋아하는 주제에서는 말이 많다.",
				status: "proposed",
			},
		});
		expect(pending.chapters.expression.status).toBe("proposed");
		expect(pending.chapters.expression.text).toContain("좋아하는 주제");
	});

	it("keeps :memory: off the filesystem", () => {
		const mem = new OnboardingStore(":memory:");
		try {
			expect(mem.snapshot().drafts).toEqual([]);
			expect(existsSync(":memory:")).toBe(false);
			expect(existsSync(join(process.cwd(), ":memory:"))).toBe(false);
		} finally {
			mem.close();
		}
	});

	it("bounds draft JSON by UTF-8 bytes and keeps 16 Korean drafts under 2MiB", () => {
		const hangul = "가".repeat(4000);
		const draft = store.createDraft(
			{ targetAgentId: null, mode: "fast" },
			{ agents, presets: [], existingCount: 0 },
		);
		let blocked = false;
		for (let i = 0; i < 20; i++) {
			try {
				store.addAnswer(draft.id, {
					revision: store.getDraft(draft.id)?.revision ?? 0,
					chapter: "identity",
					text: hangul,
					answerId: newUuid(),
				});
			} catch (error) {
				expect(String(error)).toMatch(/bytes/i);
				blocked = true;
				break;
			}
		}
		expect(blocked).toBe(true);
		expect(16 * MAX_DRAFT_BYTES).toBeLessThanOrEqual(2 * 1024 * 1024);
		const root = mkdtempSync(join(tmpdir(), "lina-onboarding-bytes-"));
		const packed = new OnboardingStore(join(root, "onboarding.sqlite"));
		try {
			for (let i = 0; i < MAX_DRAFTS; i++) {
				const item = packed.createDraft(
					{ targetAgentId: null, mode: "fast" },
					{ agents, presets: [], existingCount: 0 },
				);
				packed.patchDraft(item.id, {
					revision: item.revision,
					chapter: {
						id: "identity",
						text: "가".repeat(2000),
						status: "proposed",
					},
				});
			}
			const payload = JSON.stringify(packed.snapshot());
			expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(
				2 * 1024 * 1024,
			);
			expect(() =>
				packed.createDraft(
					{ targetAgentId: null, mode: "fast" },
					{ agents, presets: [], existingCount: 0 },
				),
			).toThrow(/capacity/i);
		} finally {
			packed.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
