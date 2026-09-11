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
