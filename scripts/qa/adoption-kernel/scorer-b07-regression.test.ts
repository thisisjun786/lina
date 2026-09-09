import { expect, test } from "bun:test";
import type { EpisodeTrace } from "./harness-types.ts";
import { scoreTrial } from "./score.ts";
import type { PrivateTruth } from "./truth.ts";

const truth: PrivateTruth = {
	version: 1,
	episodeId: "b07-repro",
	row: "B07",
	seed: "development",
	variant: 0,
	subcase: "main",
	expected: {
		value: "30",
		missing: [],
		sources: [],
		required: [],
		lookupKeys: ["key-a", "key-b"],
		operands: [10, 20],
		operation: "add",
		role: null,
		domain: null,
		sourceEvidenceId: null,
		finalStage: 0,
	},
};

// Both lookup receipts actually RETURN the wrong value (999), simulating an
// environment/lookup implementation that does not faithfully return the
// secret operand -- yet the calculate call's args and output are hand-set to
// the true secret operands/value directly, never actually reading the wrong
// receipt output. The scorer never compares lookup output(x)["value"] against
// the operand used in calculate, so this passes as if the chain held.
const trace = {
	version: 1,
	episodeId: "b07-repro",
	mode: "kernel",
	status: "complete",
	requests: [],
	steps: [],
	effects: [
		{
			effectId: "lookup-a",
			tool: "lookup",
			args: { key: "key-a" },
			receipt: {
				effectId: "lookup-a",
				status: "completed",
				output: { value: 999 },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
		{
			effectId: "lookup-b",
			tool: "lookup",
			args: { key: "key-b" },
			receipt: {
				effectId: "lookup-b",
				status: "completed",
				output: { value: 999 },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
		{
			effectId: "calc-1",
			tool: "calculate",
			args: { op: "add", left: 10, right: 20 },
			receipt: {
				effectId: "calc-1",
				status: "completed",
				output: { value: 30 },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
	],
	adoptions: [],
	delivered: [
		{
			effectId: "ans",
			bytes: JSON.stringify({
				outcome: "answer",
				value: "30",
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

test("B07 rejects operands disconnected from lookup receipts", () => {
	const result = scoreTrial(truth, trace as unknown as EpisodeTrace);
	expect(result.quality).toBe(false);
});

test("B07 accepts the observed operands and rejects lookups after calculation", () => {
	const valid = structuredClone(trace);
	item(valid.effects, 0).receipt.output.value = 10;
	item(valid.effects, 1).receipt.output.value = 20;
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).quality).toBe(
		true,
	);
	valid.effects.reverse();
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).quality).toBe(
		false,
	);
});

function item<T>(items: T[], index: number): T {
	const value = items[index];
	if (!value) throw Error("missing fixture");
	return value;
}
