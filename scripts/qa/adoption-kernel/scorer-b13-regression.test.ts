import { expect, test } from "bun:test";
import type { EpisodeTrace } from "./harness-types.ts";
import { scoreTrial } from "./score.ts";
import type { PrivateTruth } from "./truth.ts";

const truth: PrivateTruth = {
	version: 1,
	episodeId: "b13-repro",
	row: "B13",
	seed: "development",
	variant: 0,
	subcase: "main",
	expected: {
		value: "next-value",
		missing: [],
		sources: ["old-source"],
		required: [],
		lookupKeys: [],
		operands: [],
		operation: null,
		role: null,
		domain: null,
		sourceEvidenceId: "ev1",
		learnedRule: null,
		learningRequired: [],
		taskCondition: null,
		finalStage: 2,
	},
};

const okTransport = {
	kind: "ok",
	content: "",
	model: "m",
	usage: { prompt: 0, completion: 0 },
	latencyMs: 0,
};
const input = (adoptionIds: string[]) => ({
	messages: [],
	omitted: { rawIds: [], derivedIds: [] },
	rawIds: [],
	adoptionIds,
});

// planA is the ORIGINAL plan tied to stale revision1 of ev1: adopted pre-final,
// properly excluded from the final-stage request (as the contract demands).
// planB is a SECOND, freshly-created plan that references the SAME stale
// ev1/revision1 dependency and IS included in the final-stage request -- a
// resurrected stale dependency the contract explicitly forbids ("serialized
// active adoptions contain no revision1 dependence").
const trace = {
	version: 1,
	episodeId: "b13-repro",
	mode: "kernel",
	status: "complete",
	requests: [
		{ stage: 0, input: input([]), transport: okTransport, proposal: null },
		{
			stage: 1,
			input: input(["planA"]),
			transport: okTransport,
			proposal: null,
		},
		{
			stage: 2,
			input: input(["planB"]),
			transport: okTransport,
			proposal: null,
		},
	],
	steps: [],
	effects: [],
	adoptions: [
		{
			id: "planA",
			revision: 1,
			subject: "agent",
			domain: "real",
			visibility: "private",
			kind: "plan",
			text: "original plan",
			refs: [{ id: "ev1", revision: 1 }],
			condition: "",
			status: "withdrawn",
			sourceDecisionId: "d0",
		},
		{
			id: "planB",
			revision: 1,
			subject: "agent",
			domain: "real",
			visibility: "private",
			kind: "plan",
			text: "resurrected stale plan, still depends on revision1",
			refs: [{ id: "ev1", revision: 1 }],
			condition: "",
			status: "active",
			sourceDecisionId: "d2",
		},
	],
	delivered: [
		{
			effectId: "ans",
			bytes: JSON.stringify({
				outcome: "answer",
				value: "next-value",
				missing: [],
				claims: [],
				verificationIds: [],
			}),
			audience: "private",
			stage: 2,
		},
	],
	stages: [],
	bridges: [],
};

test("B13 rejects a replacement plan that resurrects stale evidence", () => {
	const result = scoreTrial(truth, trace as unknown as EpisodeTrace);
	expect(result.uptake).toBe(false);
});

test("B13 accepts complete withdrawal and rejects indirect stale dependence", () => {
	const valid = structuredClone(trace);
	item(valid.requests, 2).input.adoptionIds = [];
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).uptake).toBe(true);
	item(valid.requests, 2).input.adoptionIds = ["planB"];
	item(valid.adoptions, 1).refs = [{ id: "planA", revision: 1 }];
	expect(scoreTrial(truth, valid as unknown as EpisodeTrace).uptake).toBe(
		false,
	);
});

function item<T>(items: T[], index: number): T {
	const value = items[index];
	if (!value) throw Error("missing fixture");
	return value;
}
