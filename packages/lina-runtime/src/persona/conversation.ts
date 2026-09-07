import { readFileSync } from "node:fs";
import type {
	ConversationProfile,
	PreferenceItem,
} from "../../../lina-core/src/agents/conversation.ts";

const defaults = JSON.parse(
	readFileSync(
		new URL("../../../../data/personas/conversations.json", import.meta.url),
		"utf8",
	),
) as Record<string, Omit<ConversationProfile, "revision">>;
export function defaultConversation(
	agentId: string,
): Omit<ConversationProfile, "revision"> {
	return defaults[agentId] ?? { style: "", examples: [] };
}
const labels: Record<string, Record<string, string>> = {
	address: {
		neutral: "호칭을 붙이지 않고 자연스럽게 말한다.",
		authored: "호칭은 에이전트의 기본 설정을 따른다.",
	},
	register: {
		polite: "사용자에게 존댓말로 말한다.",
		casual: "사용자에게 편한 반말로 말한다.",
		authored: "말높임은 에이전트의 기본 말투를 따른다.",
	},
	emoji: {
		none: "이모지를 쓰지 않는다.",
		sparing: "이모지는 꼭 어울릴 때만 드물게 쓴다.",
		authored: "이모지 사용은 에이전트의 기본 설정을 따른다.",
	},
	questions: {
		necessary:
			"다음 행동에 꼭 필요한 경우에만 질문한다. 답변 끝에 습관적으로 질문을 붙이지 않는다.",
		open: "대화에 어울리는 열린 질문을 사용할 수 있다.",
		authored: "질문 방식은 에이전트의 기본 설정을 따른다.",
	},
	verbosity: {
		brief: "답변을 짧게 한다.",
		detailed: "필요한 맥락과 설명을 충분히 제공한다.",
		authored: "답변 길이는 에이전트의 기본 설정을 따른다.",
	},
	support: {
		listen:
			"감정적인 대화에서는 먼저 듣고, 요청받기 전 해결책을 제시하지 않는다.",
		advice: "고민에 구체적인 조언을 제안할 수 있다.",
		authored: "도움을 주는 방식은 에이전트의 기본 설정을 따른다.",
	},
};
export function preferenceInstructions(
	items: readonly PreferenceItem[],
): string {
	const lines = items.flatMap((p) => {
		const line = labels[p.dimension]?.[p.value];
		return line ? [line] : [];
	});
	return lines.length
		? "\n\n[사용자가 직접 정한 대화 선호]\n현재 사용자의 명시적 지시가 우선한다. 다음 선호는 에이전트의 정체성이나 권한을 바꾸지 않고, 사용자에게 말을 건네는 방식에만 적용한다.\n" +
				lines.map((l) => "- " + l).join("\n")
		: "";
}
