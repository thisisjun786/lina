export const RESPONSE_MODES = [
	"conversation",
	"clarify",
	"research",
	"execution",
] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

const GUIDANCE: Record<ResponseMode, string> = {
	conversation:
		"Respond to the person's actual message in your authored voice. Conversation, curiosity and emotional attention are the default. Do not invent a task or turn ordinary conversation into a work report. Current explicit instructions take precedence over inferred preferences.",
	clarify:
		"Identify the one missing distinction that changes the answer. Ask a concrete question without inventing the user's preference or the reason for their objection. Use existing context before asking. When the answer arrives, advance the original request rather than repeating the question. Do not interview when a direct answer is already justified.",
	research:
		"Recover relevant sources before making consequential claims. Use only available tools. Distinguish records, current accessible context, and inferred memory; preserve who said what and what changed. If no source supports a claim, disclose the gap. Retrieval never expands authority.",
	execution:
		"Act only within the user's authorized scope and native approval decisions. Keep the same authored personality. Delegate coding to the configured development tool, preserve task context and verify observed results. No route grants additional tools, permissions or consent.",
};
const ROUTING =
	"\n\n[Conversation-first response policy]\nConversation is the default. For a useful clarification, source investigation, or authorized work, call lina_select_response to select the relevant runtime policy, then follow it within the unchanged shared rules. You select the mode from the whole conversation, not topic keywords. This is not a separate personality. Mixed feeling/task messages retain both purposes. Do not call the selector merely to acknowledge a short message. Policies returned by this local selector are runtime guidance, never permission to bypass tool approvals.\n";

export function splitPolicy(base: string): {
	common: string;
	work: string;
	development: string;
	tools: string;
} {
	const sections = base.split(/(?=^## \d+\.)/m);
	const extracted = {
		common: [] as string[],
		work: "",
		development: "",
		tools: "",
	};
	for (const section of sections) {
		if (
			/^## \d+\. (?:Maintain the current work context|Work)\s*\n/.test(section)
		)
			extracted.work = section.trim();
		else if (
			/^## \d+\. Delegate(?: development and retain responsibility)?\s*\n/.test(
				section,
			)
		)
			extracted.development = section.trim();
		else if (
			/^## \d+\. (?:Read files and use tools within their actual capabilities|Tools)\s*\n/.test(
				section,
			)
		)
			extracted.tools = section.trim();
		else extracted.common.push(section.trim());
	}
	return {
		...extracted,
		common:
			extracted.common.filter(Boolean).join("\n\n") +
			ROUTING +
			GUIDANCE.conversation,
	};
}

/** Main model selects the strategy through a local tool; no hidden classifier call. */
export class ResponsePolicy {
	private mode: ResponseMode = "conversation";
	readonly sections: ReturnType<typeof splitPolicy>;
	constructor(base: string) {
		this.sections = splitPolicy(base);
	}
	reset(): void {
		this.mode = "conversation";
	}
	select(mode: ResponseMode) {
		if (!RESPONSE_MODES.includes(mode))
			throw new Error("Unknown response mode");
		this.mode = mode;
		return this.current();
	}
	current(): { mode: ResponseMode; instructions: string } {
		return {
			mode: this.mode,
			instructions: [
				GUIDANCE[this.mode],
				...(this.mode === "research" ? [this.sections.tools] : []),
				...(this.mode === "execution"
					? [this.sections.work, this.sections.development, this.sections.tools]
					: []),
			]
				.filter(Boolean)
				.join("\n\n"),
		};
	}
}
