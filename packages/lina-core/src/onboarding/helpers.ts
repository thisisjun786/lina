import { randomUUID } from "node:crypto";
import type { AgentInput } from "../agents/types.ts";
import { validateAgentInput } from "../agents/validation.ts";
import {
	CHAPTER_IDS,
	CHAPTERS,
	type Chapter,
	type ChapterId,
	type ChapterProposal,
	type ChapterStatus,
	MAX_ANSWER_TEXT,
	MAX_ANSWERS_PER_CHAPTER,
	MAX_AUTOMATIC_FOLLOWUPS,
	MAX_CHAPTER_TEXT,
	MAX_PROPOSAL_QUESTION,
	MAX_USER_ANSWER,
	UNSPECIFIED,
	USER_ANSWER_KEYS,
	type UserAnswers,
	UUID_RE,
} from "./types.ts";

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

export function newUuid(): string {
	return randomUUID();
}

export function newAgentId(): string {
	return `agent-${randomUUID().slice(0, 8)}`;
}

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

export function cloneChapters(
	chapters: Record<ChapterId, Chapter>,
): Record<ChapterId, Chapter> {
	return structuredClone(chapters);
}

export function unspecifiedProfile(id: string): AgentInput {
	return {
		id,
		name: UNSPECIFIED,
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

export function fillUnspecified(profile: AgentInput): AgentInput {
	const fill = (value: string): string =>
		value.trim().length === 0 ? UNSPECIFIED : value;
	return validateAgentInput({
		...profile,
		name: fill(profile.name),
		role: fill(profile.role),
		personality: fill(profile.personality),
		voice: fill(profile.voice),
		profile: fill(profile.profile),
		appearance: fill(profile.appearance),
	});
}

export function object(
	value: unknown,
	keys: ReadonlySet<string>,
	label: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`invalid ${label}`);
	const result = value as Record<string, unknown>;
	for (const key of Object.keys(result))
		if (!keys.has(key)) throw new Error(`unknown ${label} field ${key}`);
	return result;
}

export function field(row: Record<string, unknown>, key: string): unknown {
	return row[key];
}

export function optionalText(
	value: unknown,
	label: string,
	max: number,
): string {
	if (
		typeof value !== "string" ||
		value.length > max ||
		value.includes("\u0000")
	)
		throw new Error(`invalid ${label}`);
	return value;
}

export function parseUserAnswers(value: unknown): UserAnswers {
	const input = object(value, new Set(USER_ANSWER_KEYS), "user answers");
	if (Object.keys(input).length !== USER_ANSWER_KEYS.length)
		throw new Error("invalid user answers");
	const result = emptyUserAnswers();
	for (const key of USER_ANSWER_KEYS)
		result[key] = optionalText(input[key], key, MAX_USER_ANSWER);
	return result;
}

export function parseChapterId(value: unknown): ChapterId {
	if (typeof value !== "string" || !CHAPTER_IDS.includes(value as ChapterId))
		throw new Error("invalid chapter");
	return value as ChapterId;
}

export function parseChapterStatus(value: unknown): ChapterStatus {
	if (
		value !== "untouched" &&
		value !== "proposed" &&
		value !== "confirmed" &&
		value !== "deferred"
	)
		throw new Error("invalid chapter status");
	return value;
}

export function parseProposal(
	value: unknown,
	answerIds: string[],
): ChapterProposal {
	const input = object(
		value,
		new Set(["text", "question", "sourceIds"]),
		"proposal",
	);
	if (Object.keys(input).length !== 3)
		throw new Error("invalid proposal fields");
	const text = optionalText(
		field(input, "text"),
		"proposal text",
		MAX_CHAPTER_TEXT,
	);
	const question = optionalText(
		field(input, "question"),
		"proposal question",
		MAX_PROPOSAL_QUESTION,
	);
	if (text.trim().length === 0) throw new Error("blank proposal");
	const ids = field(input, "sourceIds");
	if (!Array.isArray(ids) || ids.length === 0)
		throw new Error("invalid proposal sourceIds");
	const sourceIds = ids.map((id) => {
		if (typeof id !== "string" || !isUuid(id))
			throw new Error("invalid proposal sourceIds");
		return id;
	});
	const known = new Set(answerIds);
	if (sourceIds.some((id) => !known.has(id)))
		throw new Error("unsupported proposal sourceIds");
	return { text, question, sourceIds };
}

export function parseChapterText(value: unknown): string {
	return optionalText(value, "chapter text", MAX_CHAPTER_TEXT);
}

export function parseAnswerText(value: unknown): string {
	const text = optionalText(value, "answer", MAX_ANSWER_TEXT);
	if (text.trim().length === 0) throw new Error("invalid answer");
	return text;
}

export function assertFollowups(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > MAX_AUTOMATIC_FOLLOWUPS
	)
		throw new Error("invalid followups");
	return value;
}

export function assertAnswerCapacity(count: number): void {
	if (count > MAX_ANSWERS_PER_CHAPTER)
		throw new Error("chapter answer capacity reached");
}

export function parseInterviewMode(value: unknown): "fast" | "thoughtful" {
	if (value !== "fast" && value !== "thoughtful")
		throw new Error("invalid interview mode");
	return value;
}

export function requireRevision(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0)
		throw new Error("invalid revision");
	return value as number;
}

export function requireUuid(value: unknown, label: string): string {
	if (typeof value !== "string" || !isUuid(value))
		throw new Error(`invalid ${label}`);
	return value;
}

export function fields(
	input: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	if (
		Object.keys(input).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(input, key))
	)
		throw new Error(`unknown ${label} field`);
}

export function confirmedChapterRefs(
	chapters: Record<ChapterId, Chapter>,
	except: ChapterId,
): Array<{ id: ChapterId; title: string; text: string; answerIds: string[] }> {
	return CHAPTERS.filter((meta) => meta.id !== except).flatMap((meta) => {
		const chapter = chapters[meta.id];
		if (chapter.status !== "confirmed" || chapter.text.trim().length === 0)
			return [];
		return [
			{
				id: meta.id,
				title: meta.title,
				text: chapter.text,
				answerIds: chapter.answers.map((answer) => answer.id),
			},
		];
	});
}
