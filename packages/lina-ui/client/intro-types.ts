import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import type { DialogueData } from "../../lina-core/src/onboarding/dialogue-types.ts";
import { UUID_RE } from "../../lina-core/src/onboarding/types.ts";
import {
	CHAPTER_IDS,
	type ChapterId,
	type InterviewMode,
	type UserAnswers,
} from "./onboarding-types.ts";

export type { AgentInput, ChapterId, InterviewMode, UserAnswers };
export { CHAPTER_IDS, UUID_RE };

export const INTRO_TURN_LIMIT = 4000;
export const INTRO_MANAGE_TIMEOUT_MS = 15_000;
export const INTRO_MODEL_TIMEOUT_MS = 75_000;
export const FAST_TURN_TARGET = 3;
export const USER_THOUGHTFUL_TARGET = 6;
export const PERSONA_THOUGHTFUL_TARGET = 12;
export const BIRTH_STORAGE_KEY = "lina.intro.birthId";
export const INTRO_DRAFT_PREFIX = "lina.intro.draft.";
export const INTRO_REQUEST_PREFIX = "lina.intro.request.";

export type IntroKind = "user" | "persona";
export type IntroStatus = "active" | "applying" | "choices" | "done";
export type IntroTurnStatus = "pending" | "done" | "failed";
export type IntroChapters = Record<ChapterId, string>;

export type IntroData = DialogueData;

export type IntroRoom = {
	id: string;
	agentId: string;
	kind: IntroKind;
	status: IntroStatus;
	revision: number;
	mode: InterviewMode;
	draftId: string | null;
	data: IntroData;
	createdAt: number;
	finalization: Record<string, unknown> | null;
};

export type IntroTurn = {
	id: string;
	requestId: string;
	seq: number;
	text: string | null;
	reply: string | null;
	status: IntroTurnStatus;
	attempts: number;
	error: string | null;
	summary: string[];
	createdAt: number;
};

export type IntroSnapshot = {
	room: IntroRoom | null;
	turns: IntroTurn[];
	userRevision: number;
	shareUser: boolean;
	presets: AgentInput[];
	sessionId: string | null;
};

export type LegacyDraftRef = { id: string; name: string };

export type IntroEntry = {
	firstUser: boolean;
	resume: { id: string; agentId: string } | null;
	legacyDrafts: LegacyDraftRef[];
};

export type ChooseResult = {
	agentId: string;
	roomId: string | null;
	url: string;
};

export type BootQuery = {
	agentId: string | null;
	onboarding: "user" | string | null;
	previous: string | null;
};

export type BootDecision =
	| { kind: "normal"; agentId: string }
	| { kind: "intro"; intent: "user" }
	| { kind: "intro"; intent: "room"; roomId: string; agentId?: string }
	| { kind: "entry" };

export type IntroBubble = {
	id: string;
	turnId: string;
	requestId: string;
	role: "user" | "assistant";
	text: string;
	state: "done" | "pending" | "failed" | "stopped" | "preparing";
	error: string | null;
};

export type MemoryStore = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem?(key: string): void;
};

export const USER_REVIEW_FIELDS = [
	{ key: "address", label: "불러 주는 호칭" },
	{ key: "context", label: "하루의 맥락" },
	{ key: "interests", label: "관심사" },
	{ key: "communication", label: "원하는 대화 방식" },
	{ key: "boundaries", label: "경계" },
	{ key: "currentFocus", label: "지금 신경 쓰이는 일" },
] as const;

export const PROFILE_REVIEW_FIELDS = [
	{ key: "name", label: "이름" },
	{ key: "role", label: "하는 일" },
	{ key: "personality", label: "기본 인격" },
	{ key: "voice", label: "말투" },
	{ key: "profile", label: "프로필" },
	{ key: "appearance", label: "외형" },
] as const;

export const CHAPTER_REVIEW_FIELDS: { key: ChapterId; label: string }[] = [
	{ key: "identity", label: "정체와 이야기" },
	{ key: "values", label: "가치와 선택" },
	{ key: "temperament", label: "기질과 상황 반응" },
	{ key: "interests", label: "독립적 관심과 동기" },
	{ key: "relationship", label: "관계와 갈등 회복" },
	{ key: "expression", label: "표현과 예시 대화" },
];
