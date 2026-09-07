import { expect, test } from "bun:test";
import {
	buildConversationPatch,
	conversationEndpoint,
	conversationPreferenceLabel,
	conversationPreferenceValue,
	validateConversationExamples,
} from "../client/conversation-draft.ts";

test("builds the scoped conversation endpoint", () => {
	expect(conversationEndpoint("lina")).toBe("/api/agents/lina/conversation");
	expect(conversationEndpoint("a/b")).toBe("/api/agents/a%2Fb/conversation");
});

test("allows zero to six complete example pairs", () => {
	const pair = { situation: "상황", response: "응답" };
	expect(validateConversationExamples([])).toBeUndefined();
	expect(
		validateConversationExamples([pair, pair, pair, pair, pair, pair, pair]),
	).toBe("예시는 6개까지 입력할 수 있습니다.");
	expect(
		validateConversationExamples([
			{ situation: "", response: "응답" },
			pair,
			pair,
		]),
	).toBe("상황과 응답을 모두 입력해주세요.");
	expect(validateConversationExamples([pair, pair, pair])).toBeUndefined();
});

test("builds a revision guarded profile patch", () => {
	expect(
		buildConversationPatch(7, {
			style: "짧게 답하기",
			examples: [{ situation: "질문", response: "답" }],
		}),
	).toEqual({
		revision: 7,
		patch: {
			style: "짧게 답하기",
			examples: [{ situation: "질문", response: "답" }],
		},
	});
});

test("maps stored preference dimensions to human labels", () => {
	expect(conversationPreferenceLabel("verbosity")).toBe("답변 길이");
	expect(conversationPreferenceLabel("unknown-dimension")).toBe("대화 선호");
});

test("renders explicit preference enum meanings without raw codes or reversed meaning", () => {
	expect(conversationPreferenceValue("none")).toBe("사용 안 함");
	expect(conversationPreferenceValue("necessary")).toBe("필요할 때만");
	expect(conversationPreferenceValue("authored")).toBe("기본 설정");
});
