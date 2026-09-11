import { expect, test } from "bun:test";
import type { CapturedRequest } from "./live-capture.ts";
import { PROPOSERS } from "./moirai-cases.ts";
import type { RoleReply } from "./moirai-runner.ts";
import { inspectMoiraiWire } from "./moirai-wire.ts";

const roles = [...PROPOSERS, "moirai"] as const;
const replies: readonly RoleReply[] = roles.map((role) => ({
	role,
	sessionId: `session-${role}`,
	// A legacy-shaped fixture makes the old role-label validator's blind spot observable.
	systemPrompt: JSON.stringify({ module_id: role }),
	input: JSON.stringify({ source: "fixture" }),
	text: `reply-${role}`,
}));
const records = replies.map((reply) => ({
	request: {
		model: "ollama-cloud/glm-5.3-flash",
		prompt_cache_key: reply.sessionId,
		input: [
			{ role: "system", content: reply.systemPrompt },
			{ role: "user", content: reply.input },
		],
	},
	status: 200,
	response: `data: ${JSON.stringify({
		type: "response.completed",
		response: {
			status: "completed",
			model: "glm-5.3-flash",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: reply.text }],
				},
			],
			usage: { input_tokens: 10, output_tokens: 5 },
		},
	})}\n\n`,
	headers: {},
	elapsedMs: 1,
}));

test("accepts exact native-session, input and output joins", () => {
	// Given four independently identified request/reply pairs.
	// When inspecting their captured wire records.
	const result = inspectMoiraiWire(records, replies);
	// Then all joins succeed and usage is retained.
	expect(result.errors).toEqual([]);
	expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 20 });
});

test("accepts completed output above the former application token cap", () => {
	// Given valid provider completions reporting more than 4096 output tokens.
	const large = records.map((record) => ({
		...record,
		response: record.response.replace(
			'"output_tokens":5',
			'"output_tokens":9000',
		),
	}));
	// When validating the completed responses.
	const result = inspectMoiraiWire(large, replies);
	// Then usage does not become a local output restriction.
	expect(result.errors).toEqual([]);
	expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 36000 });
});

test("retains usage from an incomplete provider response without accepting it", () => {
	// Given one incomplete response with real reported usage.
	const incomplete = records.map((record, index) => {
		if (index !== 0) return record;
		return {
			...record,
			response: record.response
				.replace("response.completed", "response.incomplete")
				.replace('"status":"completed"', '"status":"incomplete"')
				.replace('"output_tokens":5', '"output_tokens":4096'),
		};
	});
	// When inspecting the whole run.
	const result = inspectMoiraiWire(incomplete, replies);
	// Then failure remains a failure but its token use is not silently zero.
	expect(result.errors.length).toBeGreaterThan(0);
	expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 4111 });
});

test("unknown usage after an HTTP failure stays unknown", () => {
	// Given one response without a provider usage receipt.
	const failed = records.map((record, index) => {
		if (index !== 0) return record;
		return { ...record, status: 503, response: "unavailable" };
	});
	// When inspecting the aggregate.
	const result = inspectMoiraiWire(failed, replies);
	// Then no complete cost total is fabricated from the successful subset.
	expect(result.errors.length).toBeGreaterThan(0);
	expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
});

type Corruption = {
	readonly name: string;
	readonly apply: () => readonly CapturedRequest[];
};
const corruptions: readonly Corruption[] = [
	{
		name: "unknown session key",
		apply: () =>
			records.map((record, index) => {
				if (index !== 0) return record;
				return {
					...record,
					request: { ...record.request, prompt_cache_key: "foreign" },
				};
			}),
	},
	{
		name: "missing session key",
		apply: () =>
			records.map((record, index) => {
				if (index !== 0) return record;
				return {
					...record,
					request: Object.fromEntries(
						Object.entries(record.request).filter(
							([key]) => key !== "prompt_cache_key",
						),
					),
				};
			}),
	},
	{
		name: "duplicate session key",
		apply: () =>
			records.map((record, index) => {
				if (index !== 1) return record;
				return {
					...record,
					request: {
						...record.request,
						prompt_cache_key: records[0]?.request.prompt_cache_key,
					},
				};
			}),
	},
	{
		name: "swapped session keys",
		apply: () =>
			records.map((record, index) => {
				if (index >= 2) return record;
				return {
					...record,
					request: {
						...record.request,
						prompt_cache_key: records[1 - index]?.request.prompt_cache_key,
					},
				};
			}),
	},
	{
		name: "wrong input",
		apply: () =>
			records.map((record, index) => {
				if (index !== 0) return record;
				return {
					...record,
					request: {
						...record.request,
						input: record.request.input.map((item) =>
							item.role === "user" ? { ...item, content: "wrong-input" } : item,
						),
					},
				};
			}),
	},
	{
		name: "wrong provider output",
		apply: () =>
			records.map((record, index) => {
				if (index !== 0) return record;
				return {
					...record,
					response: record.response.replace("reply-clotho", "wrong-reply"),
				};
			}),
	},
];

for (const corruption of corruptions) {
	test(`rejects ${corruption.name}`, () => {
		// Given an otherwise valid transcript with one targeted corruption.
		const damaged = corruption.apply();
		// When inspecting the captured request/reply join.
		const result = inspectMoiraiWire(damaged, replies);
		// Then the corruption cannot be accepted as a complete run.
		expect(result.errors.length).toBeGreaterThan(0);
	});
}
