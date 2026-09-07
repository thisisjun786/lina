import { expect, test } from "bun:test";
import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import {
	boundChapterText,
	boundUserAnswers,
	canApply,
	canCreateDraft,
	chapterProgress,
	createDraftBody,
	followupsCapped,
	initialStage,
	interviewQuestion,
	openingQuestion,
	parseOnboardingError,
	previewAllowed,
	saveBadge,
	shouldClearPreview,
	userFieldSummaries,
	userPatch,
} from "../client/onboarding-model.ts";
import type {
	AgentDraft,
	Chapter,
	UserState,
} from "../client/onboarding-types.ts";
import {
	CHAPTER_IDS,
	emptyChapters,
	emptyUserAnswers,
	MAX_AGENTS,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_CHAPTER_TEXT,
	MAX_USER_ANSWER,
	UNSPECIFIED,
} from "../client/onboarding-types.ts";

function profile(id = "agent-test"): AgentInput {
	return {
		id,
		name: "세라",
		role: UNSPECIFIED,
		personality: UNSPECIFIED,
		voice: UNSPECIFIED,
		profile: UNSPECIFIED,
		appearance: UNSPECIFIED,
		interests: [],
		avatarId: null,
		evolution: "adaptive",
	};
}

function chapter(over: Partial<Chapter> = {}): Chapter {
	return {
		status: "untouched",
		text: "",
		followups: 0,
		answers: [],
		proposal: null,
		...over,
	};
}

function draft(over: Partial<AgentDraft> = {}): AgentDraft {
	return {
		id: "12345678-1234-1234-1234-123456789abc",
		revision: 1,
		targetAgentId: null,
		baseRevision: null,
		mode: "thoughtful",
		profile: profile(),
		chapters: emptyChapters(),
		appliedRevision: null,
		staleExtension: false,
		...over,
	};
}

function user(over: Partial<UserState> = {}): UserState {
	return {
		revision: 1,
		draft: emptyUserAnswers(),
		confirmed: null,
		sharedAgentIds: [],
		...over,
	};
}

test("six named chapters stay in contract order", () => {
	expect(CHAPTER_IDS).toEqual([
		"identity",
		"values",
		"temperament",
		"interests",
		"relationship",
		"expression",
	]);
});

test("user field summaries keep blanks instead of inventing answers", () => {
	const answers = emptyUserAnswers();
	answers.address = "다온";
	const rows = userFieldSummaries(answers);
	expect(rows.find((row) => row.key === "address")).toEqual({
		key: "address",
		label: "불러 주는 호칭",
		value: "다온",
		blank: false,
	});
	expect(rows.filter((row) => row.blank).map((row) => row.key)).toEqual([
		"context",
		"interests",
		"communication",
		"boundaries",
		"currentFocus",
	]);
});

test("user answers stop at the contract length", () => {
	const answers = emptyUserAnswers();
	answers.context = "가".repeat(MAX_USER_ANSWER + 1);
	const result = boundUserAnswers(answers);
	expect(result.ok).toBe(false);
	expect(result.error).toContain("600");
});

test("chapter progress reports coverage, not a quality score", () => {
	const chapters = emptyChapters();
	chapters.identity = chapter({ status: "confirmed", text: "천문학 조수" });
	chapters.values = chapter({ status: "confirmed", text: "정직" });
	chapters.temperament = chapter({ status: "confirmed", text: "차분" });
	chapters.interests = chapter({ status: "confirmed", text: "별" });
	const progress = chapterProgress(draft({ chapters }));
	expect(progress.confirmed).toBe(4);
	expect(progress.remaining).toEqual(["relationship", "expression"]);
	expect(progress.summary).toBe(
		"6개 장 중 4개를 확인했습니다. 남은 장: 관계와 의견 충돌, 표현과 대화 예시.",
	);
	expect(progress.summary).not.toContain("%");
	expect(progress.summary).not.toMatch(/67|점수|품질/);
});

test("apply needs every chapter confirmed or deferred", () => {
	const chapters = emptyChapters();
	for (const id of CHAPTER_IDS) chapters[id] = chapter({ status: "deferred" });
	expect(canApply(draft({ chapters })).ok).toBe(true);
	chapters.expression = chapter({ status: "proposed" });
	expect(canApply(draft({ chapters })).ok).toBe(false);
});

test("opening questions are the authored chapter prompts, not model diagnoses", () => {
	expect(openingQuestion("temperament", "thoughtful")).toContain("평소");
	expect(openingQuestion("identity", "fast")).toBe(
		"어떤 존재로, 왜 함께하고 싶나요?",
	);
	expect(openingQuestion("values", "fast")).toContain("선택");
});

test("after answers, empty proposal question does not invent a follow-up", () => {
	const filled = chapter({
		status: "proposed",
		followups: 2,
		answers: [{ id: "a", text: "평소엔 차분하다" }],
		proposal: { text: "차분한 편", question: "", sourceIds: ["a"] },
	});
	expect(interviewQuestion(filled, "temperament", "thoughtful")).toBeNull();
	expect(followupsCapped(filled)).toBe(true);
	expect(MAX_AUTOMATIC_FOLLOWUPS).toBe(2);
});

test("automatic cap hides leftover proposal questions unless deepening", () => {
	const capped = chapter({
		status: "proposed",
		followups: 2,
		answers: [{ id: "a", text: "차분해요" }],
		proposal: {
			text: "차분한 편",
			question: "어떤 이야기에 그렇게 신나나요?",
			sourceIds: ["a"],
		},
	});
	expect(interviewQuestion(capped, "temperament", "thoughtful")).toBeNull();
	expect(interviewQuestion(capped, "temperament", "thoughtful", true)).toBe(
		"어떤 이야기에 그렇게 신나나요?",
	);
});

test("preset draft body sends presetId and never an agents create payload", () => {
	expect(
		createDraftBody({
			targetAgentId: null,
			presetId: "sera",
			mode: "fast",
		}),
	).toEqual({
		targetAgentId: null,
		presetId: "sera",
		mode: "fast",
	});
	expect(createDraftBody({ targetAgentId: null, mode: "thoughtful" })).toEqual({
		targetAgentId: null,
		mode: "thoughtful",
	});
});

test("confirmed intro resumes at path instead of repeating the form", () => {
	expect(initialStage(user())).toBe("user");
	expect(
		initialStage(
			user({
				confirmed: {
					answers: emptyUserAnswers(),
					confirmedAt: 1,
					currentFocusExpiresAt: 2,
				},
			}),
		),
	).toBe("path");
});

test("new drafts are blocked at the existing agent cap", () => {
	expect(canCreateDraft(MAX_AGENTS, null)).toBe(false);
	expect(canCreateDraft(MAX_AGENTS, "lina")).toBe(true);
	expect(canCreateDraft(MAX_AGENTS - 1, null)).toBe(true);
});

test("preview requires a trailing user turn and stays bounded", () => {
	expect(previewAllowed([{ role: "assistant", content: "안녕" }]).ok).toBe(
		false,
	);
	expect(previewAllowed([{ role: "user", content: "오늘 어때?" }]).ok).toBe(
		true,
	);
});

test("profile or chapter edits clear preview proof", () => {
	const before = draft();
	const after = draft({
		chapters: {
			...before.chapters,
			identity: chapter({ status: "confirmed", text: "바뀜" }),
		},
	});
	expect(shouldClearPreview(before, after)).toBe(true);
	expect(shouldClearPreview(before, before)).toBe(false);
});

test("stale conflicts ask the UI to reload while keeping answers", () => {
	const error = parseOnboardingError(409, { error: "revision conflict" });
	expect(error.reload).toBe(true);
	expect(error.keepAnswers).toBe(true);
});

test("user confirm patch is independent of draft creation", () => {
	const answers = emptyUserAnswers();
	answers.address = "다온";
	expect(
		userPatch({
			revision: 3,
			answers,
			sharedAgentIds: [],
			confirm: true,
		}),
	).toEqual({
		revision: 3,
		answers,
		sharedAgentIds: [],
		confirm: true,
	});
});

test("chapter text respects the authored 2000 character ceiling", () => {
	expect(boundChapterText("가".repeat(MAX_CHAPTER_TEXT)).ok).toBe(true);
	expect(boundChapterText("가".repeat(MAX_CHAPTER_TEXT + 1)).ok).toBe(false);
});

test("model waits use a distinct busy label", () => {
	expect(
		saveBadge({
			busy: true,
			error: "",
			user: null,
			draft: null,
			dirty: false,
			modelBusy: true,
		}),
	).toBe("응답 준비 중");
});

test("dirty edits beat a confirmed intro badge", () => {
	expect(
		saveBadge({
			busy: false,
			error: "",
			user: user({
				confirmed: {
					answers: emptyUserAnswers(),
					confirmedAt: 1,
					currentFocusExpiresAt: 9,
				},
			}),
			draft: null,
			dirty: true,
		}),
	).toBe("수정됨");
});
