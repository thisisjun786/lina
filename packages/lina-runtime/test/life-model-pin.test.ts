import { expect, test } from "bun:test";
import { createOpenCodexModelControl } from "../../lina-opencodex/src/services.ts";
import type { ModelSettings } from "../src/models/types.ts";

test("authoring pins one settings snapshot before dispatch and preserves optional onboarding callers", async () => {
	let reads = 0;
	let posts = 0;
	const selected: ModelSettings = {
		revision: 7,
		profiles: [
			{
				id: "guide",
				provider: "opencodex",
				model: "synthetic-author",
				reasoning: "off",
			},
		],
		defaultProfileId: "guide",
		roles: {},
		agentRoles: {},
	};
	const control = createOpenCodexModelControl(
		{
			origin: () => "http://127.0.0.1:1",
			token: () => null,
			models: () => [
				{
					provider: "opencodex",
					id: "synthetic-author",
					name: "Author fixture",
					contextWindow: 32000,
					maxOutputTokens: 2048,
					reasoning: false,
					authenticated: true,
					endpoint: "responses",
				},
			],
			fetchImpl: async (_url, init) => {
				posts++;
				expect(JSON.parse(String(init?.body))["model"]).toBe(
					"synthetic-author",
				);
				return new Response(
					`data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "draft" }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		},
		() => {
			reads++;
			return selected;
		},
	);
	if (!control.authoring) throw Error("Missing authoring port");
	const input = {
		agentId: "lina",
		systemPrompt: "Synthetic author",
		messages: [{ role: "user" as const, content: "author a draft" }],
	};
	await expect(
		control.authoring(
			{ ...input, expectedSettingsRevision: 6 },
			new AbortController().signal,
		),
	).rejects.toThrow(/revision conflict/);
	expect(posts).toBe(0);
	expect(reads).toBe(1);
	expect(
		(
			await control.authoring(
				{ ...input, expectedSettingsRevision: 7 },
				new AbortController().signal,
			)
		).text,
	).toBe("draft");
	expect(reads).toBe(2);
	expect(
		(await control.authoring(input, new AbortController().signal)).text,
	).toBe("draft");
	expect(reads).toBe(3);
	expect(posts).toBe(2);
});
