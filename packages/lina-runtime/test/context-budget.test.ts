import { expect, test } from "bun:test";
import {
	conservativeEstimator,
	takeBudgetPrefix,
} from "../src/context/budget.ts";

test("budget packing includes the envelope and preserves every Unicode code point", () => {
	const text = "결정😀이유🫖".repeat(30),
		envelope = (v: string) => `[source]\n${v}\n[end]`;
	let remaining = text,
		restored = "";
	while (remaining) {
		const part = takeBudgetPrefix(
			remaining,
			40,
			conservativeEstimator,
			envelope,
		);
		expect(part.length).toBeGreaterThan(0);
		expect(conservativeEstimator.text(envelope(part))).toBeLessThanOrEqual(40);
		expect(part.isWellFormed()).toBe(true);
		restored += part;
		remaining = remaining.slice(part.length);
	}
	expect(restored).toBe(text);
	expect(() =>
		takeBudgetPrefix("😀", 1, conservativeEstimator, envelope),
	).toThrow();
});

test("summary attempts honor explicit output bounds and preserve dispatch guard", async () => {
	const { summarizeBounded } = await import("../src/context/summarize.ts");
	const caps: number[] = [];
	await summarizeBounded(
		"Important decision. ".repeat(50),
		async (_text, cap) => {
			caps.push(cap);
			return "Decision retained.";
		},
		new AbortController().signal,
		() => true,
		{
			inputTokens: 2000,
			outputTokens: 37,
			retryTokens: 19,
			estimator: conservativeEstimator,
		},
	);
	expect(caps).toEqual([37]);
});

test("working context stays valid JSON when a small budget omits fields", async () => {
	const { contextInjection } = await import("../src/context/injection.ts");
	const working = {
		revision: 1,
		goal: "원래 목표😀".repeat(80),
		decisions: ["결정A".repeat(20)],
		openItems: [],
		nextSteps: [],
		sourceEntryIds: [],
	};
	const result = contextInjection(
		working,
		"",
		[],
		{
			contextWindow: 1000,
			reserveTokens: 0,
			systemTokens: 0,
			estimateText: conservativeEstimator.text,
			estimateMessages: () => 0,
			summarize: async () => "",
			prepare() {
				throw Error("unused");
			},
		},
		350,
	);
	expect(result.omittedParts).toContain("working");
	expect(result.text).not.toBe("");
	if (result.text) {
		const capsule = result.text.split("Working state: ")[1]?.split("\n")[0];
		expect(capsule).toBeDefined();
		expect(() => JSON.parse(capsule ?? "")).not.toThrow();
		expect(result.text.isWellFormed()).toBe(true);
	}
	expect(result.tokens).toBeLessThanOrEqual(350);
});
