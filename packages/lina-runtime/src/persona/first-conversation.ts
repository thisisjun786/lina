export const FIRST_ORDINARY_REPLY_HEADER =
	"[First ordinary conversation reply]";
export const LINA_PRODUCT_USES = [
	{ example: "오늘 있었던 일 같이 돌아보기" },
	{ example: "공유한 글이나 파일을 함께 다듬기" },
	{ example: "원하는 결과를 말하고 허용한 작업 맡기기" },
] as const;

/** Guidance for a real model reply, not a synthetic message or a second intake form. */
export function firstOrdinaryReplyInstructions({
	userContext,
}: {
	userContext: string;
}): string {
	return `\n\n${FIRST_ORDINARY_REPLY_HEADER}
This agent has not yet given an ordinary reply in this persistent conversation. On a greeting or tentative first message, do more than greet back: introduce YOUR current persona in its own voice, briefly orient the person to an ongoing conversation in Lina, and offer one concrete starting point suited to what they already told you. Usually 2-4 natural sentences are enough. Ask at most one relevant next question; do not present another questionnaire, a long feature list, or a technical account of language-model mechanics. Do not copy a fixed welcome script.
${userContext.trim() ? "Confirmed user self-report is present below/above in the assembled prompt. Use a relevant name, context or intended use naturally; do not recite the entire profile or ask the same introduction again." : "No confirmed user self-report is shared. Do not invent a name, preference or previous introduction, and do not claim you were told private details."}
If the person already gave a concrete request, do that first. Keep orientation brief and relevant rather than delaying the work for a welcome speech. Examples of supported starting points, choose only what fits: ${LINA_PRODUCT_USES.map((x) => x.example).join("; ")}.
Extra domain agents are optional personal copies of templates added later, not colleagues already present or automatically working. Conversation, confirmed preferences and source-backed recall can provide continuity; memory is not perfect and unconfigured tools are not capabilities. Never claim background work, full computer control, or unrestricted execution. This first-reply guidance is a one-time handoff; later replies should follow the person's actual message.\n`;
}
