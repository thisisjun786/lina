import { expect, test } from "bun:test";
import type { EpisodeTrace } from "./harness-types.ts";
import { scoreTrial } from "./score.ts";
import type { PrivateTruth } from "./truth.ts";

const truth: PrivateTruth = {
	version: 1,
	episodeId: "b11-wrong-value-full",
	row: "B11",
	seed: "s",
	variant: 0,
	subcase: "main",
	expected: {
		value: "a,b,c",
		missing: [],
		sources: [],
		required: ["a", "b", "c"],
		lookupKeys: [],
		operands: [],
		operation: null,
		role: null,
		domain: null,
		sourceEvidenceId: null,
		learnedRule: { method: "M", when: "C" },
		learningRequired: [],
		taskCondition: "C",
		finalStage: 1,
	},
};
const q = {
	kind: "ok",
	content: "",
	model: "m",
	usage: { prompt: 0, completion: 0 },
	latencyMs: 0,
};
const trace = {
	version: 1,
	episodeId: "b11-wrong-value-full",
	mode: "kernel",
	status: "complete",
	requests: [
		{
			stage: 1,
			input: {
				messages: [],
				omitted: { rawIds: [], derivedIds: [] },
				rawIds: [],
				adoptionIds: ["u"],
			},
			transport: q,
			proposal: null,
		},
	],
	steps: [
		{
			stage: 1,
			kernel: { status: "dispatched", decisionId: "submit" },
			requestIndex: 0,
		},
		{
			stage: 1,
			kernel: { status: "dispatched", decisionId: "verify" },
			requestIndex: 0,
		},
	],
	effects: [
		{
			effectId: "precheck",
			tool: "check",
			args: { submissionId: "prelude" },
			receipt: {
				effectId: "precheck",
				status: "completed",
				output: { missing: ["c"] },
				quality: { status: "fail", verifier: null, detail: "" },
			},
		},
		{
			effectId: "submit:tool",
			tool: "submit",
			args: { taskKey: "t", items: ["a", "b", "c"] },
			receipt: {
				effectId: "submit:tool",
				status: "completed",
				output: { items: ["a", "b", "c"] },
				quality: { status: "unverified", verifier: null, detail: "" },
			},
		},
		{
			effectId: "verify:tool",
			tool: "check",
			args: { submissionId: "submit:tool" },
			receipt: {
				effectId: "verify:tool",
				status: "completed",
				output: { pass: true },
				quality: { status: "pass", verifier: null, detail: "" },
			},
		},
	],
	adoptions: [
		{
			id: "u",
			revision: 1,
			subject: "agent",
			domain: "real",
			visibility: "private",
			kind: "understanding",
			text: "conditional",
			refs: [{ id: "check-evidence", revision: 1 }],
			condition: "C",
			status: "active",
			sourceDecisionId: "adopt",
		},
	],
	delivered: [
		{
			effectId: "ans",
			bytes: JSON.stringify({
				outcome: "answer",
				value: "WRONG",
				missing: [],
				claims: [],
				verificationIds: ["verify:tool"],
			}),
			audience: "private",
			stage: 1,
		},
	],
	stages: [],
	bridges: [
		{
			evidenceId: "check-evidence",
			effectId: "precheck",
			owner: "check",
			revision: 1,
		},
	],
};
test("B11 rejects wrong final value in the historical reviewer fixture", () => {
	const r = scoreTrial(truth, trace as unknown as EpisodeTrace);
	expect([r.quality, r.uptake]).toEqual([false, false]);
});
