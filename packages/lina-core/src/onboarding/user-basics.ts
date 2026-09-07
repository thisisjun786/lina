import type { UserAnswers } from "./types.ts";

export const BASIC_FIELDS = [
	{
		key: "address",
		label: "이름·호칭",
		question: "어떤 이름이나 호칭으로 불러드리면 좋을까요?",
	},
	{
		key: "context",
		label: "생활 맥락",
		question: "평소 어떤 일을 하거나 어떻게 하루를 보내세요?",
	},
	{
		key: "interests",
		label: "관심 주제",
		question: "요즘 관심 있는 주제나 여기서 함께해 보고 싶은 일이 있나요?",
	},
	{
		key: "communication",
		label: "대화 방식",
		question: "제가 어떤 말투나 답변 방식으로 이야기하면 편하실까요?",
	},
] as const;
export type UserBasicField = (typeof BASIC_FIELDS)[number]["key"];
export type UserSkipped = Partial<Record<UserBasicField, string>>;
export function parseUserSkipped(value: unknown): UserSkipped {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid skipped basics");
	const result: UserSkipped = {};
	for (const [key, quote] of Object.entries(value)) {
		if (
			!BASIC_FIELDS.some((f) => f.key === key) ||
			typeof quote !== "string" ||
			!quote.trim() ||
			quote.length > 4000
		)
			throw Error("invalid skipped basic evidence");
		result[key as UserBasicField] = quote;
	}
	return result;
}
export function userBasics(
	user: Partial<UserAnswers>,
	skipped: UserSkipped = {},
) {
	const missing = BASIC_FIELDS.filter(
		(f) => !user[f.key]?.trim() && !skipped[f.key],
	).map((f) => f.key);
	return {
		missing,
		completed: BASIC_FIELDS.length - missing.length,
		total: BASIC_FIELDS.length,
	};
}
