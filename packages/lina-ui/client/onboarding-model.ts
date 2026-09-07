import type { AgentInput } from "../../lina-core/src/agents/types.ts";
import {
	type AgentDraft,
	CHAPTER_IDS,
	CHAPTERS,
	type Chapter,
	type ChapterId,
	type CreateDraftInput,
	CURRENT_FOCUS_TTL_MS,
	emptyUserAnswers,
	FAST_CHAPTER_IDS,
	FAST_PROMPTS,
	type InterviewMode,
	MAX_AGENTS,
	MAX_ANSWER_TEXT,
	MAX_ANSWERS_PER_CHAPTER,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_CHAPTER_TEXT,
	MAX_PREVIEW_CHARS,
	MAX_PREVIEW_MESSAGES,
	MAX_USER_ANSWER,
	PROFILE_LIMITS,
	type PreviewMessage,
	type SaveUserInput,
	USER_FIELDS,
	type UserAnswers,
	type UserState,
	type WizardStage,
} from "./onboarding-types.ts";

const TITLE: Record<ChapterId, string> = {
	identity: "정체와 이야기",
	values: "가치와 선택",
	temperament: "기질과 상황 반응",
	interests: "독립된 관심과 동기",
	relationship: "관계와 의견 충돌",
	expression: "표현과 대화 예시",
};

export function userFieldSummaries(answers: UserAnswers): {
	key: (typeof USER_FIELDS)[number]["key"];
	label: string;
	value: string;
	blank: boolean;
}[] {
	return USER_FIELDS.map((field) => {
		const value = answers[field.key].trim();
		return {
			key: field.key,
			label: field.label,
			value,
			blank: value.length === 0,
		};
	});
}

export function boundUserAnswers(answers: UserAnswers): {
	ok: boolean;
	answers: UserAnswers;
	error?: string;
} {
	const next = emptyUserAnswers();
	for (const field of USER_FIELDS) {
		const value = answers[field.key];
		if (value.length > MAX_USER_ANSWER)
			return {
				ok: false,
				answers,
				error: `${field.label}은 ${MAX_USER_ANSWER}자까지 적을 수 있습니다.`,
			};
		next[field.key] = value;
	}
	return { ok: true, answers: next };
}

export function boundChapterText(text: string): {
	ok: boolean;
	text: string;
	error?: string;
} {
	if (text.length > MAX_CHAPTER_TEXT)
		return {
			ok: false,
			text,
			error: `장 내용은 ${MAX_CHAPTER_TEXT}자까지 적을 수 있습니다.`,
		};
	return { ok: true, text };
}

export function boundAnswerText(text: string): {
	ok: boolean;
	text: string;
	error?: string;
} {
	const trimmed = text.trim();
	if (!trimmed) return { ok: false, text, error: "답을 적은 뒤 보내주세요." };
	if (trimmed.length > MAX_ANSWER_TEXT)
		return {
			ok: false,
			text,
			error: `답은 ${MAX_ANSWER_TEXT}자까지 적을 수 있습니다.`,
		};
	return { ok: true, text: trimmed };
}

export function chapterTitle(id: ChapterId): string {
	return TITLE[id];
}

export function openingQuestion(id: ChapterId, mode: InterviewMode): string {
	if (mode === "fast" && (FAST_CHAPTER_IDS as readonly string[]).includes(id))
		return FAST_PROMPTS[id as (typeof FAST_CHAPTER_IDS)[number]];
	const found = CHAPTERS.find((item) => item.id === id);
	return found?.question ?? "";
}

export function interviewQuestion(
	chapter: Chapter,
	id: ChapterId,
	mode: InterviewMode,
	deepening = false,
): string | null {
	if (chapter.answers.length === 0) return openingQuestion(id, mode);
	if (followupsCapped(chapter) && !deepening) return null;
	const next = chapter.proposal?.question.trim() ?? "";
	return next.length > 0 ? next : null;
}

export function followupsCapped(chapter: Chapter): boolean {
	return chapter.followups >= MAX_AUTOMATIC_FOLLOWUPS;
}

export function canDeepen(chapter: Chapter): boolean {
	return followupsCapped(chapter) && chapter.answers.length > 0;
}

export function needsInterviewRetry(chapter: Chapter): boolean {
	return (
		chapter.answers.length > 0 &&
		!followupsCapped(chapter) &&
		!chapter.proposal?.question.trim()
	);
}

export function remainingChapters(draft: AgentDraft): ChapterId[] {
	const ids = draft.mode === "fast" ? FAST_CHAPTER_IDS : CHAPTER_IDS;
	return ids.filter((id) => {
		const status = draft.chapters[id].status;
		return status === "untouched" || status === "proposed";
	});
}

export function untouchedChapters(draft: AgentDraft): ChapterId[] {
	return CHAPTER_IDS.filter((id) => draft.chapters[id].status === "untouched");
}

export function chapterProgress(draft: AgentDraft): {
	confirmed: number;
	deferred: number;
	remaining: ChapterId[];
	summary: string;
} {
	const ids = draft.mode === "fast" ? FAST_CHAPTER_IDS : CHAPTER_IDS;
	let confirmed = 0;
	let deferred = 0;
	const remaining: ChapterId[] = [];
	for (const id of ids) {
		const status = draft.chapters[id].status;
		if (status === "confirmed") confirmed += 1;
		else if (status === "deferred") deferred += 1;
		else remaining.push(id);
	}
	const total = ids.length;
	const names = remaining.map((id) => TITLE[id]).join(", ");
	if (remaining.length === 0)
		return {
			confirmed,
			deferred,
			remaining,
			summary: `${total}개 장을 모두 확인하거나 미뤘습니다.`,
		};
	const done = `${total}개 장 중 ${confirmed}개를 확인했습니다.`;
	return {
		confirmed,
		deferred,
		remaining,
		summary: `${done} 남은 장: ${names}.`,
	};
}

export function canApply(draft: AgentDraft): { ok: boolean; reason?: string } {
	const pending = CHAPTER_IDS.filter((id) => {
		const status = draft.chapters[id].status;
		return status === "untouched" || status === "proposed";
	});
	if (pending.length)
		return {
			ok: false,
			reason: "아직 정하지 않은 장이 있습니다. 확인하거나 미뤄주세요.",
		};
	return { ok: true };
}

export function canCreateDraft(
	agentCount: number,
	targetAgentId: string | null,
): boolean {
	return targetAgentId !== null || agentCount < MAX_AGENTS;
}

export function resumableTargetDraft(
	drafts: AgentDraft[],
	targetAgentId: string,
	currentRevision: number | null,
): AgentDraft | undefined {
	if (currentRevision === null) return undefined;
	return drafts.find(
		(item) =>
			item.targetAgentId === targetAgentId &&
			item.appliedRevision === null &&
			item.baseRevision === currentRevision,
	);
}

export function draftRevisionConflict(
	item: AgentDraft,
	currentRevision: number | null,
): boolean {
	return (
		item.targetAgentId !== null &&
		currentRevision !== null &&
		item.baseRevision !== currentRevision
	);
}

export function initialStage(
	user: UserState,
	options: { forceUser?: boolean } = {},
): WizardStage {
	if (options.forceUser) return "user";
	if (user.confirmed) return "path";
	return "user";
}

export function currentFocusExpired(expiresAt: number, now: number): boolean {
	return now >= expiresAt;
}

export function currentFocusActive(user: UserState, now: number): boolean {
	const confirmed = user.confirmed;
	if (!confirmed?.answers.currentFocus.trim()) return false;
	return now < confirmed.currentFocusExpiresAt;
}

export function createDraftBody(input: CreateDraftInput): CreateDraftInput {
	const body: CreateDraftInput = {
		targetAgentId: input.targetAgentId,
		mode: input.mode,
	};
	if (input.presetId) body.presetId = input.presetId;
	return body;
}

export function userPatch(input: SaveUserInput): SaveUserInput {
	return {
		revision: input.revision,
		answers: input.answers,
		sharedAgentIds: input.sharedAgentIds,
		confirm: input.confirm,
	};
}

export function previewCharCount(messages: PreviewMessage[]): number {
	return messages.reduce((sum, item) => sum + item.content.length, 0);
}

export function previewAllowed(messages: PreviewMessage[]): {
	ok: boolean;
	reason?: string;
} {
	if (messages.length === 0)
		return { ok: false, reason: "미리볼 말을 먼저 보내주세요." };
	if (messages.length > MAX_PREVIEW_MESSAGES)
		return {
			ok: false,
			reason: `미리보기는 ${MAX_PREVIEW_MESSAGES}마디까지입니다.`,
		};
	if (previewCharCount(messages) > MAX_PREVIEW_CHARS)
		return {
			ok: false,
			reason: `미리보기는 ${MAX_PREVIEW_CHARS}자까지입니다.`,
		};
	if (messages.at(-1)?.role !== "user")
		return { ok: false, reason: "마지막 말은 사용자가 보내야 합니다." };
	return { ok: true };
}

export function shouldClearPreview(
	previous: AgentDraft,
	next: AgentDraft,
): boolean {
	if (previous.id !== next.id || previous.mode !== next.mode) return true;
	if (JSON.stringify(previous.profile) !== JSON.stringify(next.profile))
		return true;
	for (const id of CHAPTER_IDS) {
		const before = previous.chapters[id];
		const after = next.chapters[id];
		if (
			before.status !== after.status ||
			before.text !== after.text ||
			before.answers.length !== after.answers.length
		)
			return true;
	}
	return false;
}

export function parseOnboardingError(
	status: number,
	body: unknown,
	fallback = "요청을 완료하지 못했습니다.",
): { message: string; reload: boolean; keepAnswers: true } {
	const extracted =
		body && typeof body === "object" && "error" in body
			? String(body.error)
			: "";
	if (status === 409)
		return {
			message:
				extracted || "다른 곳에서 내용이 바뀌었습니다. 최신 내용을 불러옵니다.",
			reload: true,
			keepAnswers: true,
		};
	if (status === 429)
		return {
			message:
				extracted ||
				"이미 다른 요청이 진행 중입니다. 잠시 후 다시 시도해주세요.",
			reload: false,
			keepAnswers: true,
		};
	if (status === 502)
		return {
			message:
				extracted ||
				"모델 응답을 받지 못했습니다. 적은 답은 그대로 남아 있습니다.",
			reload: false,
			keepAnswers: true,
		};
	if (status === 504)
		return {
			message:
				extracted ||
				"모델 응답이 늦어 중단했습니다. 적은 답은 그대로 남아 있습니다.",
			reload: false,
			keepAnswers: true,
		};
	if (status === 400)
		return {
			message: extracted || "요청을 확인해주세요.",
			reload: false,
			keepAnswers: true,
		};
	return {
		message: extracted || fallback,
		reload: false,
		keepAnswers: true,
	};
}

export function saveBadge(input: {
	busy: boolean;
	error: string;
	user: UserState | null;
	draft: AgentDraft | null;
	dirty: boolean;
	modelBusy?: boolean;
}): string {
	if (input.busy) return input.modelBusy ? "응답 준비 중" : "저장 중";
	if (input.error) return "오류";
	if (input.dirty) return "수정됨";
	if (input.draft) return "캐릭터 초안 저장됨";
	if (input.user?.confirmed) return "소개 확인됨";
	if (input.user) return "소개 초안 저장됨";
	return "초안";
}

export function profileWithinLimits(profile: AgentInput): string | undefined {
	if (profile.name.length > PROFILE_LIMITS.name)
		return `이름은 ${PROFILE_LIMITS.name}자까지입니다.`;
	if (profile.role.length > PROFILE_LIMITS.role)
		return `하는 일은 ${PROFILE_LIMITS.role}자까지입니다.`;
	if (profile.personality.length > PROFILE_LIMITS.personality)
		return `기본 인격은 ${PROFILE_LIMITS.personality}자까지입니다.`;
	if (profile.voice.length > PROFILE_LIMITS.voice)
		return `말투는 ${PROFILE_LIMITS.voice}자까지입니다.`;
	if (profile.profile.length > PROFILE_LIMITS.profile)
		return `프로필은 ${PROFILE_LIMITS.profile}자까지입니다.`;
	if (profile.appearance.length > PROFILE_LIMITS.appearance)
		return `외형은 ${PROFILE_LIMITS.appearance}자까지입니다.`;
	return undefined;
}

export function canAcceptAnswer(chapter: Chapter): boolean {
	return chapter.answers.length < MAX_ANSWERS_PER_CHAPTER;
}

export function focusTtlMs(): number {
	return CURRENT_FOCUS_TTL_MS;
}
