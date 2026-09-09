import { expect, test } from "bun:test";
import type { EpisodeTrace } from "./harness-types.ts";
import { scoreTrial } from "./score.ts";
import type { PrivateTruth } from "./truth.ts";

const truth: PrivateTruth = {
	version: 1,
	episodeId: "b09-repro",
	row: "B09",
	seed: "development",
	variant: 0,
	subcase: "main",
	expected: {
		value: null,
		missing: [],
		sources: [],
		required: ["r1", "r2", "r3"],
		lookupKeys: [],
		operands: [],
		operation: null,
		role: null,
		domain: null,
		sourceEvidenceId: null,
		finalStage: 0,
	},
};

// Model NEVER checks the prelude's real faulty submission. Instead it submits
// its own deliberately-incomplete items, gets a self-inflicted "fail", then
// fixes it. The prelude submission (episodeId:prelude:0) is never referenced.
const trace = {
	version: 1,
	episodeId: "b09-repro",
	mode: "kernel",
	status: "complete",
	requests: [],
	steps: [],
	effects: [
		{
			effectId: "d1:tool",
			tool: "submit",
			args: { taskKey: "t", items: ["r1", "r2"], method: "self-inflicted" },
			receipt: {
				effectId: "d1:tool",
				status: "completed",
				output: { items: ["r1", "r2"] },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
		{
			effectId: "d2:tool",
			tool: "check",
			args: { submissionId: "d1:tool" },
			receipt: {
				effectId: "d2:tool",
				status: "completed",
				output: {},
				quality: { status: "fail", verifier: null, detail: "missing r3" },
			},
		},
		{
			effectId: "d3:tool",
			tool: "submit",
			args: { taskKey: "t", items: ["r1", "r2", "r3"], method: "good" },
			receipt: {
				effectId: "d3:tool",
				status: "completed",
				output: { items: ["r1", "r2", "r3"] },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
		{
			effectId: "d4:tool",
			tool: "check",
			args: { submissionId: "d3:tool" },
			receipt: {
				effectId: "d4:tool",
				status: "completed",
				output: {},
				quality: { status: "pass", verifier: null, detail: "" },
			},
		},
	],
	adoptions: [],
	delivered: [
		{
			effectId: "ans",
			bytes: JSON.stringify({
				outcome: "answer",
				value: "done",
				missing: [],
				claims: [],
				verificationIds: ["d4:tool"],
			}),
			audience: "private",
			stage: 0,
		},
	],
	stages: [],
	bridges: [],
};

test("B09 rejects failure checks unrelated to the original submission", () => {
	const result = scoreTrial(truth, trace as unknown as EpisodeTrace);
	expect(result.quality).toBe(false);
});

test("B09 accepts repair of the checked original and rejects a different task", () => {
	const valid = structuredClone(trace);
	item(valid.effects, 0).effectId = `${truth.episodeId}:prelude:0`;
	item(valid.effects, 0).receipt.effectId = item(valid.effects, 0).effectId;
	item(valid.effects, 1).args.submissionId = item(valid.effects, 0).effectId;
	Object.assign(item(valid.effects, 1).receipt.output, {
		submissionId: item(valid.effects, 0).effectId,
		missing: ["r3"],
		extra: [],
		pass: false,
	});
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).quality).toBe(
		true,
	);
	item(valid.effects, 2).args.taskKey = "unrelated";
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).quality).toBe(
		false,
	);
});

function item<T>(items: T[], index: number): T {
	const value = items[index];
	if (!value) throw Error("missing fixture");
	return value;
}

test("B09 requires the failed check to identify the actual missing item", () => {
	const invalid = structuredClone(trace);
	item(invalid.effects, 0).effectId = `${truth.episodeId}:prelude:0`;
	item(invalid.effects, 0).receipt.effectId = `${truth.episodeId}:prelude:0`;
	item(invalid.effects, 1).args.submissionId = `${truth.episodeId}:prelude:0`;
	expect(scoreTrial(truth, invalid as unknown as EpisodeTrace).quality).toBe(
		false,
	);
});
