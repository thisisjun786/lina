import { expect, test } from "bun:test";
import { prepareContextInput } from "../src/context/native.ts";

const message = (id: string, text: string) => ({
	id,
	type: "message",
	message: { role: "user", content: text },
});
const project = (entry: unknown): unknown[] => {
	const value = entry as { message?: unknown };
	return value.message ? [value.message] : [];
};
test("split-turn sources follow native preparation and exclude already summarized originals", () => {
	const old = message("old", "old text"),
		a = message("a", "history"),
		b = message("b", "turn prefix"),
		kept = message("kept", "recent");
	const compact = {
		id: "compact",
		type: "compaction",
		summary: "previous summary",
		firstKeptEntryId: "a",
	};
	const result = prepareContextInput(
		{
			requestId: "request",
			reason: "manual",
			branchEntries: [old, a, compact, b, kept],
			preparation: {
				firstKeptEntryId: "kept",
				tokensBefore: 3000,
				previousSummary: "previous summary",
				messagesToSummarize: [a.message],
				turnPrefixMessages: [b.message],
				isSplitTurn: true,
			},
		},
		project,
		(text) => text.length <= 500,
	);
	expect(result.sourceEntryIds).toEqual(["a", "b"]);
	expect(result.previousCompactionId).toBe("compact");
	expect(result.fits("x".repeat(501))).toBe(false);
});
test("a missing cut, mismatched projection or unsupported branch fails before summaries", () => {
	const a = message("a", "history"),
		kept = message("kept", "recent");
	const event = {
		requestId: "request",
		reason: "manual",
		branchEntries: [a, kept],
		preparation: {
			firstKeptEntryId: "kept",
			tokensBefore: 3000,
			messagesToSummarize: [a.message],
			turnPrefixMessages: [],
			isSplitTurn: false,
		},
	};
	expect(() =>
		prepareContextInput({ ...event, reason: "branch" }, project, () => true),
	).toThrow("branch");
	expect(() =>
		prepareContextInput({ ...event, branchEntries: [a] }, project, () => true),
	).toThrow("cut");
	expect(() =>
		prepareContextInput(
			event,
			() => [{ role: "user", content: "changed" }],
			() => true,
		),
	).toThrow("projection");
});
