import { expect, test } from "bun:test";
import { readCompletion } from "../src/client.ts";

const response = (events: unknown[]) =>
	new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
test("native Responses terminal output can be empty after streamed text was emitted", async () => {
	const result = await readCompletion(
		response([
			{ type: "response.output_text.delta", delta: "LINA_SERVICE_OK" },
			{ type: "response.output_text.done", text: "LINA_SERVICE_OK" },
			{
				type: "response.completed",
				response: {
					status: "completed",
					output: [],
					usage: { input_tokens: 42, output_tokens: 8 },
				},
			},
		]),
		10000,
	);
	expect(result).toEqual({
		text: "LINA_SERVICE_OK",
		inputTokens: 42,
		outputTokens: 8,
	});
});
test("truncated streams and incomplete events never become accepted summaries", async () => {
	await expect(
		readCompletion(
			response([{ type: "response.output_text.delta", delta: "partial" }]),
			10000,
		),
	).rejects.toThrow();
	await expect(
		readCompletion(
			response([
				{ type: "response.output_text.done", text: "partial" },
				{
					type: "response.incomplete",
					response: {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			]),
			10000,
		),
	).rejects.toThrow();
});
