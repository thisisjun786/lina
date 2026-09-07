import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import { MAX_AGENTS } from "../../lina-core/src/agents/validation.ts";
import type {
	AgentDraft,
	ApplyRequest,
	ApplyResult,
	Chapter,
	ChapterId,
	ChapterProposal,
	ChapterStatus,
	CreateDraftInput,
	InterviewMode,
	InterviewRequest,
	InterviewResult,
	OnboardingSnapshot,
	PatchDraftInput,
	PreviewMessage,
	PreviewRequest,
	PreviewResult,
	SaveUserInput,
	UserAnswers,
	UserState,
} from "../../lina-core/src/onboarding/types.ts";
import {
	CHAPTER_IDS,
	CHAPTERS,
	CURRENT_FOCUS_TTL_MS,
	MAX_ANSWER_TEXT,
	MAX_ANSWERS_PER_CHAPTER,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_CHAPTER_TEXT,
	MAX_PREVIEW_CHARS,
	MAX_PREVIEW_MESSAGES,
	MAX_USER_ANSWER,
	UNSPECIFIED,
	USER_ANSWER_KEYS,
} from "../../lina-core/src/onboarding/types.ts";

export type {
	AgentDraft,
	AgentInput,
	ApplyRequest,
	ApplyResult,
	Chapter,
	ChapterId,
	ChapterProposal,
	ChapterStatus,
	CreateDraftInput,
	InterviewMode,
	InterviewRequest,
	InterviewResult,
	OnboardingSnapshot,
	PatchDraftInput,
	PreviewMessage,
	PreviewRequest,
	PreviewResult,
	SaveUserInput,
	UserAnswers,
	UserState,
};
export {
	CHAPTER_IDS,
	CHAPTERS,
	CURRENT_FOCUS_TTL_MS,
	MAX_AGENTS,
	MAX_ANSWER_TEXT,
	MAX_ANSWERS_PER_CHAPTER,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_CHAPTER_TEXT,
	MAX_PREVIEW_CHARS,
	MAX_PREVIEW_MESSAGES,
	MAX_USER_ANSWER,
	UNSPECIFIED,
	USER_ANSWER_KEYS,
};

export const FAST_CHAPTER_IDS = [
	"identity",
	"temperament",
	"relationship",
] as const;
export type FastChapterId = (typeof FAST_CHAPTER_IDS)[number];
export const MANAGE_TIMEOUT_MS = 15_000;
export const MODEL_TIMEOUT_MS = 75_000;

export const PROFILE_LIMITS = {
	name: 80,
	role: 500,
	personality: 1400,
	voice: 1600,
	profile: 1200,
	appearance: 3000,
} as const;

export const USER_FIELDS = [
	{
		key: "address",
		label: "불러 주는 호칭",
		hint: "예: 이름, 별명. 비워 두면 부르지 않습니다.",
	},
	{
		key: "context",
		label: "하루의 맥락",
		hint: "일과나 생활 리듬처럼 알아두면 좋은 배경.",
	},
	{
		key: "interests",
		label: "관심사",
		hint: "요즘 즐기는 일이나 주제.",
	},
	{
		key: "communication",
		label: "원하는 대화 방식",
		hint: "짧게, 구체적으로, 먼저 결론 등.",
	},
	{
		key: "boundaries",
		label: "경계",
		hint: "하지 않았으면 하는 말이나 주제.",
	},
	{
		key: "currentFocus",
		label: "지금 신경 쓰이는 일",
		hint: "7일 뒤 만료됩니다. 범위는 나중에 고칠 수 있습니다.",
	},
] as const;

export type PreviewSceneId = "ordinary" | "disagreement" | "reconnect";
export type PreviewSceneStatus = "pending" | "reviewed" | "skipped";
export type WizardStage =
	| "user"
	| "user-review"
	| "path"
	| "mode"
	| "interview"
	| "profile"
	| "preview"
	| "apply";

export type ExistingAgent = {
	id: string;
	name: string;
	role: string;
	revision: number;
};

export const FAST_PROMPTS: Record<FastChapterId, string> = {
	identity: "어떤 존재로, 왜 함께하고 싶나요?",
	temperament: "평소에는 어떤 태도로 말하고 행동하면 좋을까요?",
	relationship: "당신과 어떤 관계를 바라나요?",
};

export const PREVIEW_SCENES: {
	id: PreviewSceneId;
	label: string;
	prompt: string;
}[] = [
	{ id: "ordinary", label: "일상 대화", prompt: "오늘 하루 어땠어?" },
	{
		id: "disagreement",
		label: "의견이 다를 때",
		prompt: "난 그 방향은 별로인 것 같아.",
	},
	{
		id: "reconnect",
		label: "오랜만에 다시 만날 때",
		prompt: "오랜만이야. 그동안 잘 지냈어?",
	},
];

export const CHAPTER_FINISH: Record<ChapterId, string> = {
	identity: "누구인지와 함께하는 이유가 확인되거나 미뤄지면 이 장은 끝입니다.",
	values: "중요한 선택 기준이 확인되거나 미뤄지면 이 장은 끝입니다.",
	temperament: "평소와 상황별 반응이 확인되거나 미뤄지면 이 장은 끝입니다.",
	interests: "스스로의 관심사가 확인되거나 미뤄지면 이 장은 끝입니다.",
	relationship: "관계와 의견 충돌 풀이가 확인되거나 미뤄지면 이 장은 끝입니다.",
	expression: "말투 예시가 확인되거나 미뤄지면 이 장은 끝입니다.",
};

export const STATUS_LABEL: Record<ChapterStatus, string> = {
	untouched: "손대지 않음",
	proposed: "제안",
	confirmed: "확인함",
	deferred: "미룸",
};

export function emptyUserAnswers(): UserAnswers {
	return {
		address: "",
		context: "",
		interests: "",
		communication: "",
		boundaries: "",
		currentFocus: "",
	};
}

export function emptyChapter(): Chapter {
	return {
		status: "untouched",
		text: "",
		followups: 0,
		answers: [],
		proposal: null,
	};
}

export function emptyChapters(): Record<ChapterId, Chapter> {
	return {
		identity: emptyChapter(),
		values: emptyChapter(),
		temperament: emptyChapter(),
		interests: emptyChapter(),
		relationship: emptyChapter(),
		expression: emptyChapter(),
	};
}
