import type { ModelRouteRequest } from "../models/types.ts";
import {
	type ContextEstimator,
	measuredTokens,
	takeBudgetPrefix,
} from "./budget.ts";

export interface SummaryBudget {
	inputTokens: number;
	outputTokens: number;
	retryTokens: number;
	estimator: ContextEstimator;
}

export type SummaryCall = (
	text: string,
	maxTokens: number,
	signal: AbortSignal,
	/** Trusted synchronous source check; not serialized into the summary prompt. */
	beforeDispatch?: () => void,
	routeRequest?: ModelRouteRequest,
) => Promise<string>;

/** A bounded escalation path, with visible degradation and no source deletion. */
export async function summarizeBounded(
	input: string,
	call: SummaryCall,
	signal: AbortSignal,
	fits: (text: string) => boolean = () => true,
	budget?: SummaryBudget,
): Promise<{ text: string; kind: "model" | "extractive" }> {
	if (!input || input.length > 32_768)
		throw new Error("Summary input must be nonempty and bounded");
	if (budget && measuredTokens(budget.estimator, input) > budget.inputTokens)
		throw Error("Summary input exceeds token budget");
	const maxChars = Math.min(8192, Math.max(64, Math.floor(input.length * 0.6)));
	for (const maxTokens of budget
		? [budget.outputTokens, budget.retryTokens]
		: [2048, 512]) {
		signal.throwIfAborted();
		try {
			const text = (await call(input, maxTokens, signal)).trim();
			signal.throwIfAborted();
			if (
				text &&
				text.length <= maxChars &&
				text.length < input.length &&
				(!budget || measuredTokens(budget.estimator, text) <= maxTokens) &&
				fits(text)
			)
				return { text, kind: "model" };
		} catch {
			signal.throwIfAborted();
		}
	}
	const marker =
		"[Extractive fallback: abridged; expand sources for originals]\n";
	for (
		let size = maxChars;
		size >= marker.length;
		size = Math.floor(size / 2)
	) {
		signal.throwIfAborted();
		let excerpt = input.slice(0, size - marker.length);
		if (excerpt.length && /[\uD800-\uDBFF]/.test(excerpt.at(-1) ?? ""))
			excerpt = excerpt.slice(0, -1);
		if (budget) {
			try {
				excerpt = takeBudgetPrefix(
					excerpt,
					budget.retryTokens,
					budget.estimator,
					(value) => marker + value,
				);
			} catch {
				continue;
			}
		}
		const text = marker + excerpt;
		if (text.length < input.length && fits(text))
			return { text, kind: "extractive" };
	}
	throw new Error("Summary and kept context cannot fit the model budget");
}
