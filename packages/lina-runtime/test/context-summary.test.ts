import { expect, test } from "bun:test";
import { summarizeBounded } from "../src/context/summarize.ts";

test("a reducing summary uses one call and records model origin", async () => {
	let calls = 0;
	const result = await summarizeBounded(
		"User decided blue. ".repeat(100),
		async () => {
			calls++;
			return "User chose blue; work is unfinished.";
		},
		new AbortController().signal,
	);
	expect(result).toEqual({
		text: "User chose blue; work is unfinished.",
		kind: "model",
	});
	expect(calls).toBe(1);
});

test("non-reducing outputs and provider failures fall back visibly", async () => {
	const input = "Original material. ".repeat(400);
	const calls: number[] = [];
	const result = await summarizeBounded(
		input,
		async (_text, budget) => {
			calls.push(budget);
			if (calls.length === 1) return input;
			throw new Error("provider unavailable");
		},
		new AbortController().signal,
	);
	expect(calls.length).toBe(2);
	expect(calls[1]).toBeLessThan(calls[0] ?? 0);
	expect(result.kind).toBe("extractive");
	expect(result.text).toContain("Extractive fallback");
	expect(result.text.length).toBeLessThan(input.length);
});

test("root sizing includes kept-context admission and fallback stays within it", async () => {
	const result = await summarizeBounded(
		"Unfinished project. ".repeat(400),
		async () => "x".repeat(700),
		new AbortController().signal,
		(text) => text.length <= 200,
	);
	expect(result.kind).toBe("extractive");
	expect(result.text.length).toBeLessThanOrEqual(200);
	await expect(
		summarizeBounded(
			"Unfinished project. ".repeat(400),
			async () => "summary",
			new AbortController().signal,
			() => false,
		),
	).rejects.toThrow("cannot fit");
});

test("abort during generation cannot retry or produce an accepted fallback", async () => {
	const controller = new AbortController();
	let calls = 0;
	await expect(
		summarizeBounded(
			"Original. ".repeat(100),
			async () => {
				calls++;
				controller.abort();
				return "short";
			},
			controller.signal,
		),
	).rejects.toThrow();
	expect(calls).toBe(1);
});

test("overlarge summarizer input is rejected instead of silently clipping source coverage", async () => {
	let calls = 0;
	await expect(
		summarizeBounded(
			"x".repeat(32769),
			async () => {
				calls++;
				return "short";
			},
			new AbortController().signal,
		),
	).rejects.toThrow("input");
	expect(calls).toBe(0);
});
