import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { type Wire, wireSchema } from "./protocol.ts";

type ToolReply = {
	readonly kind: "tool";
	readonly callId: string;
	readonly operationId: string;
};
export type Reply =
	| ToolReply
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "hold" };

export function startFixture(root: string, replies: readonly Reply[]) {
	const requests: Wire[] = [];
	const held = Promise.withResolvers<number>();
	const disconnected = Promise.withResolvers<number>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (
				new URL(request.url).pathname !== "/v1/chat/completions" ||
				request.method !== "POST"
			) {
				throw new Error(
					`Unexpected provider request: ${request.method} ${request.url}`,
				);
			}
			const wire = wireSchema.parse(await request.json());
			requests.push(wire);
			appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify(wire)}\n`);
			const reply = replies[requests.length - 1];
			if (!reply) throw new Error("Unexpected extra model request");
			if (reply.kind === "hold") {
				const index = requests.length;
				return new Promise<Response>((resolve) => {
					request.signal.addEventListener(
						"abort",
						() => {
							disconnected.resolve(index);
							resolve(new Response(null, { status: 499 }));
						},
						{ once: true },
					);
					held.resolve(index);
				});
			}
			const tool = reply.kind === "tool";
			let delta: Record<string, unknown>;
			if (reply.kind === "tool") {
				delta = {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: reply.callId,
							type: "function",
							function: {
								name: "fixture_effect",
								arguments: JSON.stringify({ operationId: reply.operationId }),
							},
						},
					],
				};
			} else {
				delta = { role: "assistant", content: reply.text };
			}
			const chunk = {
				id: "completion-fixture",
				object: "chat.completion.chunk",
				created: 1,
				model: "fixture-model",
				choices: [{ index: 0, delta, finish_reason: null }],
			};
			const finish = {
				...chunk,
				choices: [
					{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" },
				],
			};
			return new Response(
				`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	return {
		endpoint: `http://127.0.0.1:${server.port}/v1`,
		requests,
		held: held.promise,
		disconnected: disconnected.promise,
		close: () => server.stop(true),
	};
}
