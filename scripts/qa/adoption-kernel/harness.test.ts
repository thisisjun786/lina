import { expect, test } from "bun:test";
import { decodePublicCase } from "./public-case.ts";

test("public case rejects evaluator truth and unknown versions", () => {
	expect(() => decodePublicCase({ version: 2 })).toThrow();
	expect(() =>
		decodePublicCase({
			version: 1,
			episodeId: "x",
			stages: [],
			tools: [],
			environment: {
				lookups: {},
				tasks: {},
				unavailableKeys: [],
				unknownTasks: [],
			},
			prelude: [],
			expected: "LEAK",
		}),
	).toThrow();
});

import type { ModeInput } from "./harness-types.ts";
import { serializeInput, stripHostMetadata } from "./serialize.ts";

const modeInput: ModeInput = {
	purpose: {
		id: "p",
		revision: 1,
		subject: "s",
		text: "reply",
		audience: "private",
		successCriteria: "reply",
		active: true,
		policyVersion: 1,
	},
	raw: [],
	derived: [],
	tools: [],
	attempt: 1,
};
test("serializer caps whole raw items and exposes omissions", () => {
	const input = {
		...modeInput,
		raw: Array.from({ length: 20 }, (_, i) => ({
			seq: i,
			sourceId: `source${i}`,
			owner: "user",
			kind: "source" as const,
			text: "x".repeat(1000),
			domain: "real" as const,
			role: "recipient" as const,
			ref: { id: `e${i}`, revision: 1 },
		})),
	};
	const result = serializeInput(input);
	expect(result.omitted.rawIds.length).toBeGreaterThan(0);
	expect(result.rawIds.length + result.omitted.rawIds.length).toBe(20);
	expect(
		result.messages.reduce((n, item) => n + item.content.length, 0),
	).toBeLessThanOrEqual(24000);
});
test("removing derived metadata preserves identical raw serialization", () => {
	const baseline = serializeInput(modeInput);
	const kernel = serializeInput({
		...modeInput,
		derived: [
			{
				id: "a",
				revision: 1,
				subject: "s",
				domain: "real",
				visibility: "private",
				kind: "understanding",
				text: "conditional method",
				refs: [],
				condition: "C",
				status: "active",
				sourceDecisionId: "d",
			},
		],
	});
	expect(stripHostMetadata(kernel)).toBe(stripHostMetadata(baseline));
	expect(kernel.adoptionIds).toEqual(["a"]);
});

test("host ID normalization cannot erase different tool outputs", () => {
	const input = {
		...modeInput,
		raw: [
			{
				seq: 1,
				sourceId: "d:tool",
				owner: "tool:lookup",
				kind: "receipt" as const,
				text: JSON.stringify({
					effectId: "d:tool",
					receipt: { output: { value: 7 } },
				}),
				domain: "real" as const,
				role: "performer" as const,
				ref: { id: "r", revision: 1 },
			},
		],
	};
	const other = structuredClone(input);
	const item = other.raw[0];
	if (!item) throw Error("missing fixture");
	item.text = JSON.stringify({
		effectId: "d:tool",
		receipt: { output: { value: 8 } },
	});
	expect(stripHostMetadata(serializeInput(input))).not.toBe(
		stripHostMetadata(serializeInput(other)),
	);
});
