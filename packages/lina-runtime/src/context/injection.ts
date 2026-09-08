import type { WorkingState } from "../../../lina-core/src/context/index.ts";
import {
	type ContextEstimator,
	characterPrefix,
	takeBudgetPrefix,
} from "./budget.ts";
import type { ContextServices } from "./port.ts";

export type ContextOmittedPart = "working" | "recall" | "external" | "tail";
export interface ContextInjection {
	text: string;
	tokens: number;
	omitted: boolean;
	omittedParts: ContextOmittedPart[];
}
export function contextInjection(
	working: WorkingState,
	recall: string,
	messages: readonly unknown[],
	services: ContextServices,
	maxTokens = 2048,
): ContextInjection {
	const content = [
		working.goal,
		...working.decisions,
		...working.openItems,
		...working.nextSteps,
	].some(Boolean);
	const omittedParts: ContextOmittedPart[] = [];
	if (!content && !recall)
		return { text: "", tokens: 0, omitted: false, omittedParts };
	const budget = Math.min(
		maxTokens,
		services.contextWindow -
			services.reserveTokens -
			services.systemTokens -
			services.estimateMessages(messages),
	);
	const estimator: ContextEstimator = services.estimator ?? {
		id: "host-estimate-v1",
		kind: "host",
		text: services.estimateText,
		messages: services.estimateMessages,
	};
	const prefix =
		"[Reference data from prior work and memory. Latest user instructions override it.]\n";
	const state = structuredClone(working);
	let recalled = characterPrefix(recall, 4096);
	if (recalled.length < recall.length) omittedParts.push("recall");
	const render = (goal = state.goal) =>
		prefix +
		(content ? `Working state: ${JSON.stringify({ ...state, goal })}` : "") +
		(recalled ? `\nMemory (freshness unknown): ${recalled}` : "") +
		(omittedParts.includes("working")
			? "\n[Abridged; use lina_status for full working state]"
			: "");
	if (services.estimateText(render()) > budget && recalled) {
		recalled = "";
		if (!omittedParts.includes("recall")) omittedParts.push("recall");
	}
	if (services.estimateText(render()) > budget && content) {
		omittedParts.push("working");
		for (const key of [
			"nextSteps",
			"openItems",
			"decisions",
			"sourceEntryIds",
		] as const) {
			while (state[key].length && services.estimateText(render()) > budget)
				state[key].pop();
		}
		if (services.estimateText(render()) > budget) {
			try {
				state.goal = takeBudgetPrefix(
					state.goal,
					Math.max(0, budget),
					estimator,
					render,
				);
			} catch {
				state.goal = "";
			}
		}
	}
	if (!content && !recalled)
		return { text: "", tokens: 0, omitted: true, omittedParts };
	const text = render(),
		tokens = services.estimateText(text);
	if (!Number.isSafeInteger(tokens) || tokens < 0)
		throw Error("Invalid context token estimate");
	if (tokens > budget)
		return { text: "", tokens: 0, omitted: true, omittedParts };
	return { text, tokens, omitted: omittedParts.length > 0, omittedParts };
}
