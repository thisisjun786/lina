import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MOIRAI_CASES, PROPOSERS } from "./moirai-cases.ts";
import { runMoiraiCase } from "./moirai-runner.ts";
import { bounded } from "./protocol.ts";

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function reply(text: string) {
	const item = {
		id: `msg_${text}`,
		type: "message",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return new Response(
		[
			frame({ type: "response.output_item.done", output_index: 0, item }),
			frame({
				type: "response.completed",
				response: {
					id: `resp_${text}`,
					model: "glm-5.3-flash",
					status: "completed",
					output: [item],
					usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
				},
			}),
		].join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

test("five authored cases have distinct machine identities", () => {
	expect(MOIRAI_CASES.map((scenario) => scenario.id)).toEqual([
		"brief-plan",
		"conflicting-dates",
		"learned-csv-failure",
		"unknown-order",
		"listen-first",
	]);
});

for (const failOne of [false, true]) {
	test(`actual Senpi roles are parallel and isolated; failed proposer=${failOne}`, async () => {
		// Given a real HTTP barrier which cannot release until all three proposals arrive.
		const root = await mkdtemp(join(tmpdir(), "senpi-moirai-check-"));
		const entered = new Set<string>();
		const inputs: string[] = [];
		const outputInstructions = new Map<string, string>();
		const barrier = Promise.withResolvers<void>();
		let released = 0;
		let synthesis: unknown;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const body = z
					.object({
						input: z.array(
							z.object({ role: z.string(), content: z.unknown() }),
						),
						tools: z.array(z.unknown()).optional(),
					})
					.parse(await request.json());
				expect(body.tools ?? []).toEqual([]);
				const system = z
					.string()
					.parse(body.input.find((item) => item.role === "system")?.content);
				const prompt = z
					.object({ module_id: z.string(), output: z.string() })
					.parse(JSON.parse(system));
				const role = prompt.module_id;
				outputInstructions.set(role, prompt.output);
				const content = z
					.array(z.object({ type: z.literal("input_text"), text: z.string() }))
					.parse(body.input.find((item) => item.role === "user")?.content);
				const input = content.map((part) => part.text).join("");
				if (role === "moirai") {
					expect(released).toBe(3);
					synthesis = JSON.parse(input);
					return reply("moirai_reply");
				}
				entered.add(role);
				inputs.push(input);
				if (entered.size === 3) barrier.resolve();
				await bounded(barrier.promise, "three parallel SDK requests");
				released++;
				if (failOne && role === "lachesis")
					return new Response("fixture failure", { status: 503 });
				return reply(`${role}_reply`);
			},
		});
		try {
			const scenario = MOIRAI_CASES[0];
			if (!scenario) throw new Error("Missing fixed case");
			// When four actual SDK sessions run the case.
			const result = await runMoiraiCase({
				scenario,
				upstreamBaseUrl: `${server.url.origin}/v1`,
				evidenceDir: join(root, "evidence"),
			});
			// Then proposals share only the same input, and synthesis consumes their exact outputs.
			expect([...entered].sort()).toEqual([...PROPOSERS].sort());
			expect(new Set(inputs).size).toBe(1);
			expect(result.complete).toBe(!failOne);
			expect(result.cleanup.closed).toBe(true);
			expect(result.cleanup.removed).toBe(true);
			expect(existsSync(result.cleanup.scratch)).toBe(false);
			if (failOne) {
				expect(synthesis).toBeUndefined();
				expect(result.errors.length).toBeGreaterThan(0);
			} else {
				// The three proposal sessions share a format; synthesis has its own audience.
				const proposalOutputs = PROPOSERS.map((role) =>
					outputInstructions.get(role),
				);
				expect(new Set(proposalOutputs).size).toBe(1);
				expect(proposalOutputs).not.toContain(outputInstructions.get("moirai"));
				expect(new Set(result.replies.map((r) => r.sessionId)).size).toBe(4);
				expect(result.replies.map((r) => r.text)).toEqual([
					"clotho_reply",
					"lachesis_reply",
					"atropos_reply",
					"moirai_reply",
				]);
				expect(synthesis).toEqual({
					caseId: scenario.id,
					conversation: scenario.conversation,
					proposals: PROPOSERS.map((role) => ({ role, text: `${role}_reply` })),
				});
			}
		} finally {
			await server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
}
