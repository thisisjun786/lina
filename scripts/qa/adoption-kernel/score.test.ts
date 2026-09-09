import { expect, test } from "bun:test";
import type { EpisodeTrace } from "./harness-types.ts";
import { aggregateScores, scoreTrial } from "./score.ts";
import type { PrivateTruth } from "./truth.ts";

const truth: PrivateTruth = {
	version: 1,
	episodeId: "episode",
	row: "B01",
	seed: "development",
	variant: 0,
	subcase: "main",
	expected: {
		value: "offer-b",
		missing: [],
		sources: [],
		required: [],
		lookupKeys: [],
		operands: [],
		operation: null,
		role: null,
		domain: null,
		sourceEvidenceId: null,
		finalStage: 0,
	},
};
const trace: EpisodeTrace = {
	version: 1,
	episodeId: "episode",
	mode: "kernel",
	status: "complete",
	requests: [],
	steps: [],
	effects: [],
	adoptions: [],
	delivered: [
		{
			effectId: "a",
			bytes: JSON.stringify({
				outcome: "answer",
				value: "offer-b",
				missing: [],
				claims: [],
				verificationIds: [],
			}),
			audience: "private",
			stage: 0,
		},
	],
	stages: [],
	bridges: [],
};
test("scorer compares independent expected value and rejects wrong or deferred answer", () => {
	expect(scoreTrial(truth, trace).quality).toBe(true);
	expect(
		scoreTrial(
			{ ...truth, expected: { ...truth.expected, value: "offer-a" } },
			trace,
		).quality,
	).toBe(false);
	const delivered = trace.delivered[0];
	if (!delivered) throw Error("fixture missing delivery");
	expect(
		scoreTrial(truth, {
			...trace,
			delivered: [
				{
					...delivered,
					bytes: JSON.stringify({
						outcome: "defer",
						value: null,
						missing: [],
						claims: [],
						verificationIds: [],
					}),
				},
			],
		}).quality,
	).toBe(false);
});
test("missing criterion evidence cannot qualify a batch", () => {
	expect(aggregateScores([scoreTrial(truth, trace)], []).qualified).toBe(false);
});

test("copying one passing variant cannot fill a four-variant qualification row", () => {
	const trials = Array.from({ length: 15 }, (_, i) =>
		Array.from({ length: 4 }, () => ({
			episodeId: `same-${i}`,
			seed: "batch",
			variant: 0,
			subcase: "main",
			row: `B${String(i + 1).padStart(2, "0")}`,
			mode: "kernel",
			quality: true,
			uptake: null,
			incomplete: false,
			reasons: [],
		})),
	).flat();
	const hosts = Array.from({ length: 15 }, (_, i) => ({
		id: `H${String(i + 1).padStart(2, "0")}`,
		pass: true,
		sourceHash: "source",
		artifact: "proof",
	}));
	expect(aggregateScores(trials, hosts).qualified).toBe(false);
});

test("B10 requires the frozen structured defer answer, not only a kernel status", () => {
	const input = {
		...truth,
		row: "B10",
		expected: { ...truth.expected, value: null },
	};
	const fake: EpisodeTrace = {
		...trace,
		delivered: [],
		steps: [
			{
				stage: 0,
				kernel: { status: "deferred", decisionId: "d" },
				requestIndex: 0,
			},
		],
		effects: [
			{
				effectId: "d:tool",
				tool: "submit",
				args: {},
				receipt: {
					effectId: "d:tool",
					status: "unknown",
					output: null,
					quality: { status: "unverified", verifier: null, detail: "unknown" },
				},
			},
		],
	};
	expect(scoreTrial(input, fake).quality).toBe(false);
});

test("a B15 variant cannot pass with its omitted subcase missing", () => {
	const trials = Array.from({ length: 15 }, (_, i) =>
		Array.from({ length: 4 }, (_, variant) => ({
			...scoreTrial(truth, trace),
			episodeId: `${i}-${variant}`,
			row: `B${String(i + 1).padStart(2, "0")}`,
			variant,
			subcase: i === 14 ? "visible" : "main",
			seed: "batch",
			quality: true,
			uptake: null,
		})),
	).flat();
	const hosts = Array.from({ length: 15 }, (_, i) => ({
		id: `H${String(i + 1).padStart(2, "0")}`,
		pass: true,
		sourceHash: "source",
		artifact: "proof",
	}));
	expect(aggregateScores(trials, hosts).qualified).toBe(false);
});

test("kernel experience rows require affirmative uptake evidence, not null", () => {
	const trials = Array.from({ length: 15 }, (_, i) =>
		Array.from({ length: 4 }, (_, variant) =>
			(i === 14 ? ["visible", "omitted"] : ["main"]).map((subcase) => ({
				...scoreTrial(truth, trace),
				episodeId: `${i}-${variant}-${subcase}`,
				row: `B${String(i + 1).padStart(2, "0")}`,
				seed: "batch",
				variant,
				subcase,
				quality: true,
				uptake: null,
			})),
		),
	).flat(2);
	const hosts = Array.from({ length: 15 }, (_, i) => ({
		id: `H${String(i + 1).padStart(2, "0")}`,
		pass: true,
		sourceHash: "source",
		artifact: "proof",
	}));
	expect(aggregateScores(trials, hosts).qualified).toBe(false);
	const withUptake = trials.map((t) => ({
		...t,
		uptake: ["B11", "B12", "B13"].includes(t.row) ? true : null,
	}));
	expect(aggregateScores(withUptake, hosts).qualified).toBe(true);
});

test("unfinished or exhausted traces cannot pass from an earlier correct answer", () => {
	for (const status of ["incomplete", "limit"] as const) {
		const result = scoreTrial(truth, { ...trace, status });
		expect(result.quality).toBe(false);
		expect(result.incomplete).toBe(true);
	}
});
