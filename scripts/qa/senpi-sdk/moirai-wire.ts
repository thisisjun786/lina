import { z } from "zod";
import type { CapturedRequest } from "./live-capture.ts";
import type { RoleReply } from "./moirai-runner.ts";

const contentText = z.union([
	z.string(),
	z.array(z.object({ text: z.string(), type: z.string() })),
]);
function text(value: unknown): string {
	const parsed = contentText.parse(value);
	return typeof parsed === "string"
		? parsed
		: parsed.map((part) => part.text).join("");
}

export function inspectMoiraiWire(
	records: readonly CapturedRequest[],
	replies: readonly RoleReply[],
) {
	const errors: string[] = [];
	const observed = new Set<string>();
	let inputTokens: number | null = 0;
	let outputTokens: number | null = 0;
	const models = new Set<string>();
	for (const record of records) {
		try {
			if (record.status !== 200) throw new Error(`HTTP ${record.status}`);
			const body = z
				.object({
					model: z.literal("ollama-cloud/glm-5.3-flash"),
					prompt_cache_key: z.string(),
					input: z.array(
						z.looseObject({
							role: z.string().optional(),
							content: z.unknown().optional(),
						}),
					),
					tools: z.array(z.unknown()).optional(),
				})
				.parse(record.request);
			if (body.tools?.length) throw new Error("Role request exposed tools");
			const system = text(
				body.input.find(
					(item) => item.role === "system" || item.role === "developer",
				)?.content,
			);
			const expected = replies.find(
				(reply) => reply.sessionId === body.prompt_cache_key,
			);
			if (!expected)
				throw new Error(`Unknown native session: ${body.prompt_cache_key}`);
			const role = expected.role;
			if (observed.has(role))
				throw new Error(`Unexpected or duplicate role: ${role}`);
			observed.add(role);
			const userInput = text(
				body.input.find((item) => item.role === "user")?.content,
			);
			if (system !== expected.systemPrompt || userInput !== expected.input)
				throw new Error(`Role input mismatch: ${role}`);
			const events: unknown[] = [];
			for (const block of record.response
				.replaceAll("\r\n", "\n")
				.split("\n\n")) {
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data && data !== "[DONE]") events.push(JSON.parse(data));
			}
			const eventShape = z.object({
				type: z.string(),
				response: z.unknown().optional(),
			});
			const parsedEvents = events.map((event) => eventShape.parse(event));
			if (
				parsedEvents.some((event) =>
					["error", "response.failed", "response.incomplete"].includes(
						event.type,
					),
				)
			)
				throw new Error(`Failed provider event: ${role}`);
			const completions = parsedEvents.filter(
				(event) => event.type === "response.completed",
			);
			if (completions.length !== 1)
				throw new Error(`Missing or repeated completion: ${role}`);
			const response = z
				.object({
					status: z.literal("completed"),
					model: z.enum(["glm-5.3-flash", "ollama-cloud/glm-5.3-flash"]),
					output: z.array(
						z.looseObject({
							type: z.string(),
							content: z
								.array(
									z.looseObject({
										type: z.string(),
										text: z.string().optional(),
									}),
								)
								.optional(),
						}),
					),
					usage: z
						.object({
							input_tokens: z.number().int().nonnegative().optional(),
							output_tokens: z
								.number()
								.int()
								.nonnegative()
								.max(4096)
								.optional(),
						})
						.nullish(),
				})
				.parse(completions[0]?.response);
			models.add(response.model);
			const providerText = response.output
				.filter((item) => item.type === "message")
				.flatMap((item) => item.content ?? [])
				.filter((part) => part.type === "output_text")
				.map((part) => part.text ?? "")
				.join("");
			if (!providerText || providerText !== expected.text)
				throw new Error(`Provider/SDK reply mismatch: ${role}`);
			if (response.usage?.input_tokens === undefined || inputTokens === null)
				inputTokens = null;
			else inputTokens += response.usage.input_tokens;
			if (response.usage?.output_tokens === undefined || outputTokens === null)
				outputTokens = null;
			else outputTokens += response.usage.output_tokens;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (records.length !== 4 || observed.size !== 4)
		errors.push("Expected one request for each of four roles");
	return { errors, models: [...models], usage: { inputTokens, outputTokens } };
}
