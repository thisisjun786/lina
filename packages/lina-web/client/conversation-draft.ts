export type ConversationExample = { situation: string; response: string };
export type ConversationProfile = {
	revision: number;
	style: string;
	examples: ConversationExample[];
};

const MAX_EXAMPLES = 6;
const LABELS: Record<string, string> = {
	address: "호칭",
	register: "말높임",
	emoji: "이모지",
	questions: "질문",
	verbosity: "답변 길이",
	support: "공감과 조언",
};

export function conversationEndpoint(agentId: string): string {
	return `/api/agents/${encodeURIComponent(agentId)}/conversation`;
}

export function conversationPreferenceLabel(dimension: string): string {
	return LABELS[dimension] ?? "대화 선호";
}

export function validateConversationExamples(
	examples: ConversationExample[],
): string | undefined {
	if (examples.length > MAX_EXAMPLES)
		return "예시는 6개까지 입력할 수 있습니다.";
	if (examples.some((item) => !item.situation.trim() || !item.response.trim()))
		return "상황과 응답을 모두 입력해주세요.";
	if (
		examples.some(
			(item) => item.situation.length > 240 || item.response.length > 400,
		)
	)
		return "상황은 240자, 응답은 400자까지 입력할 수 있습니다.";
	return undefined;
}

export function buildConversationPatch(
	revision: number,
	patch: Pick<ConversationProfile, "style" | "examples">,
) {
	return { revision, patch };
}

export function conversationPreferenceValue(value: string): string {
	const values: Record<string, string> = {
		neutral: "호칭 없이",
		polite: "존댓말",
		casual: "반말",
		authored: "기본 설정",
		none: "사용 안 함",
		sparing: "가끔",
		necessary: "필요할 때만",
		open: "자유롭게",
		brief: "간결하게",
		detailed: "자세하게",
		listen: "먼저 듣기",
		advice: "조언 함께",
	};
	return values[value] ?? "설정 확인 필요";
}
