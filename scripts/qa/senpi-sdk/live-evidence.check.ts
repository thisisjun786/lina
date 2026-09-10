import { expect, test } from "bun:test";
import {
	evaluateLiveEvidence,
	type LiveEvidence,
	type LiveTruth,
	type LiveWire,
} from "./live-evidence.ts";

// Assigned independently of the evaluator and never recovered from model output.
const truth: LiveTruth = {
	warehouse: "west",
	sku: "BOLT",
	quantity: 37,
	receipt: "owner-west-7c21",
};
const answer =
	'{"warehouse":"west","sku":"BOLT","quantity":37,"receipt":"owner-west-7c21"}';

function sse(chunks: readonly unknown[]): string {
	return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

function wire(response: string): LiveWire {
	return {
		request: { model: "ollama-cloud/glm-5.3-flash", stream: true },
		status: 200,
		response,
	};
}

function valid(): LiveEvidence {
	return {
		initialToolCalls: 0,
		calls: [truth],
		finalText: answer,
		wire: [
			wire(
				sse([
					{
						model: "glm-5.3-flash",
						usage: { prompt_tokens: 13, completion_tokens: 2 },
					},
					{
						model: "glm-5.3-flash",
						usage: { prompt_tokens: 13, completion_tokens: 5 },
					},
					{
						model: "glm-5.3-flash",
						usage: { prompt_tokens: 13, completion_tokens: 5 },
					},
				]),
			),
			wire(
				sse([
					{ model: "ollama-cloud/glm-5.3-flash", usage: null },
					{
						model: "ollama-cloud/glm-5.3-flash",
						usage: { prompt_tokens: 21, completion_tokens: 8 },
					},
				]),
			),
		],
	};
}

test("accepts independent truth and counts cumulative usage once per response", () => {
	// Given two captured responses with repeated cumulative usage.
	const evidence = valid();
	// When the real evaluator inspects them.
	const result = evaluateLiveEvidence(evidence, truth);
	// Then the independently assigned totals and observed models survive.
	expect(result).toEqual({
		pass: true,
		failures: [],
		usage: { inputTokens: 34, outputTokens: 13 },
		responseModels: ["glm-5.3-flash", "ollama-cloud/glm-5.3-flash"],
	});
});

type NegativeCase = {
	readonly name: string;
	readonly change: Partial<LiveEvidence>;
};
const negatives: readonly NegativeCase[] = [
	{ name: "initial lookup already occurred", change: { initialToolCalls: 1 } },
	{ name: "negative initial call count", change: { initialToolCalls: -1 } },
	{ name: "no actual lookup", change: { calls: [] } },
	{ name: "duplicate actual lookup", change: { calls: [truth, truth] } },
	{
		name: "stale east lookup",
		change: { calls: [{ ...truth, warehouse: "east" }] },
	},
	{ name: "wrong lookup SKU", change: { calls: [{ ...truth, sku: "NUT" }] } },
	{
		name: "forged lookup receipt",
		change: { calls: [{ ...truth, receipt: "forged" }] },
	},
	{
		name: "wrong lookup quantity",
		change: { calls: [{ ...truth, quantity: 99 }] },
	},
	{
		name: "stale final warehouse",
		change: { finalText: answer.replace("west", "east") },
	},
	{
		name: "wrong final SKU",
		change: { finalText: answer.replace("BOLT", "NUT") },
	},
	{
		name: "forged final receipt",
		change: { finalText: answer.replace("owner-west-7c21", "forged") },
	},
	{
		name: "wrong final quantity",
		change: { finalText: answer.replace("37", "99") },
	},
	{
		name: "tool and final agree on forged truth",
		change: {
			calls: [{ ...truth, quantity: 99, receipt: "forged" }],
			finalText:
				'{"warehouse":"west","sku":"BOLT","quantity":99,"receipt":"forged"}',
		},
	},
	...[
		"",
		"not JSON",
		"null",
		"[]",
		"{}",
		`\`\`\`json\n${answer}\n\`\`\``,
		`${answer} trailing`,
		answer.replace("37", '"37"'),
		answer.replace("}", ',"extra":true}'),
		answer.replace(',"receipt":"owner-west-7c21"', ""),
	].map((finalText, index) => ({
		name: `invalid final JSON shape ${index}`,
		change: { finalText },
	})),
	{ name: "absent HTTP records", change: { wire: [] } },
	{
		name: "over-budget HTTP records",
		change: {
			wire: Array.from({ length: 7 }, () =>
				wire(sse([{ model: "glm-5.3-flash" }])),
			),
		},
	},
	...[0, 199, 300, 429, 500, Number.NaN].map((status) => ({
		name: `unsuccessful HTTP status ${status}`,
		change: { wire: [{ ...wire(sse([{ model: "glm-5.3-flash" }])), status }] },
	})),
	...[
		null,
		{},
		{ model: "glm-5.3-flash" },
		{ model: "ollama-cloud/other" },
	].map((request, index) => ({
		name: `wrong request model ${index}`,
		change: { wire: [{ ...wire(sse([{ model: "glm-5.3-flash" }])), request }] },
	})),
	{
		name: "absent response model",
		change: { wire: [wire(sse([{ choices: [] }]))] },
	},
	{
		name: "wrong response model",
		change: { wire: [wire(sse([{ model: "other" }]))] },
	},
	{
		name: "one valid response cannot hide another missing model",
		change: {
			wire: [wire(sse([{ model: "glm-5.3-flash" }])), wire(sse([{}]))],
		},
	},
	{
		name: "valid model cannot hide a wrong streaming model",
		change: {
			wire: [wire(sse([{ model: "other" }, { model: "glm-5.3-flash" }]))],
		},
	},
	{ name: "empty response", change: { wire: [wire("")] } },
	{
		name: "non-SSE JSON response",
		change: { wire: [wire('{"model":"glm-5.3-flash"}')] },
	},
	{
		name: "malformed SSE payload",
		change: {
			wire: [wire("data: {broken}\n\n" + sse([{ model: "glm-5.3-flash" }]))],
		},
	},
];

for (const { name, change } of negatives) {
	test(`rejects ${name}`, () => {
		// Given one targeted corruption of otherwise valid evidence.
		const evidence = { ...valid(), ...change };
		// When evaluated against outside truth, not its own answer.
		const result = evaluateLiveEvidence(evidence, truth);
		// Then failure is explicit; diagnostic prose is not pinned.
		expect(result.pass).toBe(false);
		expect(result.failures.length).toBeGreaterThan(0);
	});
}

test.each([
	{
		name: "absent",
		chunks: [{ model: "glm-5.3-flash" }],
		expected: { inputTokens: null, outputTokens: null },
	},
	{
		name: "null",
		chunks: [{ model: "glm-5.3-flash", usage: null }],
		expected: { inputTokens: null, outputTokens: null },
	},
	{
		name: "partial",
		chunks: [{ model: "glm-5.3-flash", usage: { prompt_tokens: 4 } }],
		expected: { inputTokens: 4, outputTokens: null },
	},
	{
		name: "zero",
		chunks: [
			{
				model: "glm-5.3-flash",
				usage: { prompt_tokens: 0, completion_tokens: 0 },
			},
		],
		expected: { inputTokens: 0, outputTokens: 0 },
	},
])("preserves $name usage without inventing tokens", ({ chunks, expected }) => {
	// Given independently assigned telemetry, including unknown values.
	const evidence = { ...valid(), wire: [wire(sse(chunks))] };
	// When evaluating the recorded response.
	const result = evaluateLiveEvidence(evidence, truth);
	// Then unknown usage does not fail an otherwise valid run or become zero.
	expect(result.pass).toBe(true);
	expect(result.failures).toEqual([]);
	expect(result.usage).toEqual(expected);
});

test("keeps totals unknown when one response omits usage", () => {
	// Given a known first response and an unmetered second response.
	const evidence = {
		...valid(),
		wire: [...valid().wire, wire(sse([{ model: "glm-5.3-flash" }]))],
	};
	// When summing telemetry.
	const result = evaluateLiveEvidence(evidence, truth);
	// Then a partial sum is not presented as the run total.
	expect(result.pass).toBe(true);
	expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
});

test("accepts six responses and SSE comments, CRLF, and multiline data", () => {
	// Given valid SSE framing and the exact request budget boundary.
	const response =
		': keepalive\r\nevent: message\r\ndata: {"model":\r\ndata: "glm-5.3-flash"}\r\n\r\ndata: [DONE]\r\n\r\n';
	const evidence = {
		...valid(),
		wire: Array.from({ length: 6 }, () => wire(response)),
	};
	// When parsing the captured stream, not matching arbitrary text.
	const result = evaluateLiveEvidence(evidence, truth);
	// Then framing and repeated models do not distort the verdict.
	expect(result).toEqual({
		pass: true,
		failures: [],
		usage: { inputTokens: null, outputTokens: null },
		responseModels: ["glm-5.3-flash"],
	});
});
