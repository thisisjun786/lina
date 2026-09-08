import { expect, test } from "bun:test";
import type { PublicationDecision } from "../src/world/publication-types.ts";
import {
	parsePublicationDecision,
	parsePublicationSettings,
} from "../src/world/publication-validation.ts";

const settings = {
	version: 1,
	agentRecipients: [
		{ agentId: "b", recipientId: "friends" },
		{ agentId: "a", recipientId: "friends" },
	],
	reactionIds: ["wave", "thanks"],
	maxChainDepth: 4,
	maxActionsPerChain: 12,
	perAuthorCooldownSteps: 1,
	maxJobsPerRun: 2,
};

test("publication settings require explicit choices and canonicalize mappings without guessing vocabulary", () => {
	const parsed = parsePublicationSettings(settings);
	expect(parsed.agentRecipients.map((r) => r.agentId)).toEqual(["a", "b"]);
	expect(parsed.reactionIds).toEqual(["thanks", "wave"]);
	expect(settings.reactionIds).toEqual(["wave", "thanks"]);
	expect(
		parsePublicationSettings({ ...settings, reactionIds: [], maxJobsPerRun: 0 })
			.maxJobsPerRun,
	).toBe(0);
	for (const invalid of [
		{},
		{ ...settings, version: 2 },
		{ ...settings, recipientId: "admin" },
		{ ...settings, maxChainDepth: -1 },
		{ ...settings, maxJobsPerRun: 0.5 },
		{ ...settings, maxActionsPerChain: Number.MAX_SAFE_INTEGER + 1 },
		{ ...settings, reactionIds: ["wave", "wave"] },
		{
			...settings,
			agentRecipients: [
				settings.agentRecipients[0],
				settings.agentRecipients[0],
			],
		},
	])
		expect(() => parsePublicationSettings(invalid)).toThrow();
});

test("narration uses only supplied claim IDs and preserves an explicit imaginative segment", () => {
	const decision: PublicationDecision = {
		kind: "post",
		segments: [
			{ kind: "claim", claimId: "public-event" },
			{ kind: "imaginative", text: "Maybe tomorrow will be quieter." },
		],
	};
	expect(parsePublicationDecision(decision, ["public-event"], "event")).toEqual(
		decision,
	);
	for (const invalid of [
		{ kind: "post", segments: [{ kind: "claim", claimId: "hidden-fact" }] },
		{
			kind: "post",
			segments: [
				{
					kind: "claim",
					claimId: "public-event",
					text: "unsupported replacement",
				},
			],
		},
		{ kind: "post", segments: [{ kind: "factual", text: "invented fact" }] },
		{ kind: "post", segments: [{ kind: "imaginative", text: "" }] },
		{ kind: "post", segments: [] },
		{ kind: "post", segments: decision.segments, audience: ["admin"] },
	])
		expect(() =>
			parsePublicationDecision(invalid, ["public-event"], "event"),
		).toThrow();
});

test("skip decisions are explicit for their job source and reject ambiguous model output", () => {
	expect(parsePublicationDecision({ kind: "no_post" }, [], "event")).toEqual({
		kind: "no_post",
	});
	expect(parsePublicationDecision({ kind: "no_reply" }, [], "reply")).toEqual({
		kind: "no_reply",
	});
	for (const invalid of [
		null,
		{},
		{ kind: "no_reply" },
		{ kind: "no_post", text: "leaked rationale" },
	])
		expect(() => parsePublicationDecision(invalid, [], "event")).toThrow();
});
