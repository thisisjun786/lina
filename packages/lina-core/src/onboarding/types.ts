import type { AgentInput } from "../agents/types.ts";

export const CHAPTER_IDS = [
	"identity",
	"values",
	"temperament",
	"interests",
	"relationship",
	"expression",
] as const;

export type ChapterId = (typeof CHAPTER_IDS)[number];

export type InterviewMode = "fast" | "thoughtful";

export type ChapterStatus = "untouched" | "proposed" | "confirmed" | "deferred";

export const USER_ANSWER_KEYS = [
	"address",
	"context",
	"interests",
	"communication",
	"boundaries",
	"currentFocus",
] as const;

export type UserAnswerKey = (typeof USER_ANSWER_KEYS)[number];

export type UserAnswers = Record<UserAnswerKey, string>;

export interface UserConfirmed {
	answers: UserAnswers;
	confirmedAt: number;
	currentFocusExpiresAt: number;
}

export interface UserState {
	revision: number;
	draft: UserAnswers;
	confirmed: UserConfirmed | null;
	sharedAgentIds: string[];
}

export interface ChapterAnswer {
	id: string;
	text: string;
}

export interface ChapterProposal {
	text: string;
	question: string;
	sourceIds: string[];
}

export interface Chapter {
	status: ChapterStatus;
	text: string;
	followups: number;
	answers: ChapterAnswer[];
	proposal: ChapterProposal | null;
}

export interface AgentDraft {
	id: string;
	revision: number;
	targetAgentId: string | null;
	baseRevision: number | null;
	mode: InterviewMode;
	profile: AgentInput;
	chapters: Record<ChapterId, Chapter>;
	appliedRevision: number | null;
	/** True when this draft imported authored chapters after an old-editor profile change; confirmed text is proposed pending re-review. */
	staleExtension: boolean;
}

export const CHAPTERS: readonly {
	id: ChapterId;
	title: string;
	question: string;
}[] = [
	{
		id: "identity",
		title: "정체와 이야기",
		question:
			"이 캐릭터는 누구인가요? 이름, 역할, 지금까지의 이야기에서 꼭 남기고 싶은 점을 알려주세요.",
	},
	{
		id: "values",
		title: "가치와 선택",
		question:
			"중요한 선택이 생기면 무엇을 지키나요? 포기하기 어려운 가치와 그 이유를 알려주세요.",
	},
	{
		id: "temperament",
		title: "기질과 상황 반응",
		question:
			"평소와 스트레스 상황에서 어떻게 달라지나요? 구체적 장면이 있다면 알려주세요.",
	},
	{
		id: "interests",
		title: "독립적 관심과 동기",
		question:
			"사용자 취향과 별개로, 이 캐릭터가 스스로 빠져드는 관심과 동기는 무엇인가요?",
	},
	{
		id: "relationship",
		title: "관계와 갈등 회복",
		question:
			"사용자와의 관계는 어떤 거리인가요? 의견이 갈리거나 서운한 뒤에는 어떻게 풀고 싶나요?",
	},
	{
		id: "expression",
		title: "표현과 예시 대화",
		question:
			"말투와 호흡은 어떤가요? 일상에서 한 줄, 또는 짧은 예시 대화를 남겨주세요.",
	},
];

export const MAX_USER_ANSWER = 600;
export const MAX_CHAPTER_TEXT = 2000;
export const MAX_ANSWER_TEXT = 4000;
export const MAX_ANSWERS_PER_CHAPTER = 20;
export const MAX_AUTOMATIC_FOLLOWUPS = 2;
export const MAX_AUTHORED_EXTENSION = 12_000;
export const MAX_PROPOSAL_QUESTION = 300;
export const MAX_DRAFTS = 16;
export const MAX_DRAFT_BYTES = 100_000;
export const MAX_DRAFT_CHARS = MAX_DRAFT_BYTES;
export const MAX_PREVIEW_MESSAGES = 12;
export const MAX_PREVIEW_CHARS = 12_000;
export const CURRENT_FOCUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const UNSPECIFIED = "아직 정하지 않았습니다.";
export const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SaveUserInput = {
	revision: number;
	answers: UserAnswers;
	sharedAgentIds: string[];
	confirm: boolean;
};

export type CreateDraftInput = {
	targetAgentId: string | null;
	presetId?: string;
	mode: InterviewMode;
};

export type PatchDraftInput = {
	revision: number;
	mode?: InterviewMode;
	profile?: AgentInput;
	chapter?: {
		id: ChapterId;
		text: string;
		status: "confirmed" | "deferred" | "proposed";
	};
};

export type AddAnswerInput = {
	revision: number;
	chapter: ChapterId;
	text: string;
	answerId: string;
};

export type InterviewRequest = {
	draftId: string;
	revision: number;
	chapter: ChapterId;
	deepen: boolean;
};

export type InterviewResult = {
	draft: AgentDraft;
	question: string;
	proposal: string;
};

export type PreviewMessage = {
	role: "user" | "assistant";
	content: string;
};

export type PreviewRequest = {
	draftId: string;
	revision: number;
	shareUser: boolean;
	messages: PreviewMessage[];
};

export type PreviewResult = {
	text: string;
	provider: string;
	model: string;
};

export type ApplyRequest = {
	revision: number;
	shareUser: boolean;
	userRevision: number;
};

export type ApplyResult = {
	agentId: string;
};

export type OnboardingSnapshot = {
	user: UserState;
	drafts: AgentDraft[];
};

export type OnboardingBoundary =
	| "intent-prepared"
	| "profile-applied"
	| "extension-written"
	| "share-applied";

export type ActiveExtension = {
	agentId: string;
	profileRevision: number;
	chapters: Record<ChapterId, Chapter>;
	applyId: string;
};
