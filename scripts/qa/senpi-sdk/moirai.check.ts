import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { MOIRAI_CASES, PROPOSERS, type Role } from "./moirai-cases.ts";
import { runMoiraiCase } from "./moirai-runner.ts";
import { atroposPrompt } from "./prompts/atropos.ts";
import { clothoPrompt } from "./prompts/clotho.ts";
import { lachesisPrompt } from "./prompts/lachesis.ts";
import { moiraiPrompt } from "./prompts/moirai.ts";
import { bounded } from "./protocol.ts";

const publishedPrompts: Readonly<Record<Role, string>> = {
	clotho: clothoPrompt,
	lachesis: lachesisPrompt,
	atropos: atroposPrompt,
	moirai: moiraiPrompt,
};
const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
function reply(text: string, complete = true) {
	const item = {
		id: `msg_${text}`,
		type: "message",
		role: "assistant",
		status: complete ? "completed" : "incomplete",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return new Response(
		[
			frame({ type: "response.output_item.done", output_index: 0, item }),
			frame({
				type: complete ? "response.completed" : "response.incomplete",
				response: {
					id: `resp_${text}`,
					model: "glm-5.3-flash",
					status: complete ? "completed" : "incomplete",
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

for (const failure of ["none", "http", "partial"] as const) {
	test(`actual Senpi roles are parallel and isolated; failure=${failure}`, async () => {
		const failOne = failure !== "none";
		// Given a real HTTP barrier which cannot release until all three proposals arrive.
		const root = await mkdtemp(join(tmpdir(), "senpi-moirai-check-"));
		const entered = new Set<string>();
		const inputs: string[] = [];
		const outputLimits: unknown[] = [];
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
						max_output_tokens: z.unknown().optional(),
					})
					.parse(await request.json());
				expect(body.tools ?? []).toEqual([]);
				outputLimits.push(body.max_output_tokens);
				const system = z
					.string()
					.parse(body.input.find((item) => item.role === "system")?.content);
				const role = Object.entries(publishedPrompts).find(
					([, prompt]) => prompt === system,
				)?.[0];
				if (!role) throw new Error("Request did not carry a published prompt");
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
				if (role === "lachesis") {
					switch (failure) {
						case "http":
							return new Response("fixture failure", { status: 503 });
						case "partial":
							return reply("partial_lachesis", false);
						case "none":
							break;
					}
				}
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
				expect(outputLimits).toEqual([
					undefined,
					undefined,
					undefined,
					undefined,
				]);
				// Compare shipped copies, not prompt wording or implementation-generated expectations.
				for (const reply of result.replies)
					expect(reply.systemPrompt).toBe(publishedPrompts[reply.role]);
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
					proposals: PROPOSERS.map((role) => `${role}_reply`),
				});
			}
		} finally {
			await server.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
}
