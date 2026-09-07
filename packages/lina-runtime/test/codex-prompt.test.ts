import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { codexAssistantPrompt } from "../src/codex-prompt.ts";
import { createCodexTaskTools } from "../src/tools/codex-tasks.ts";

test("runtime prompt references only the real task tools", () => {
	const base = readFileSync("data/app-system-prompt.md", "utf8");
	const prompt = codexAssistantPrompt(base);
	const declared = new Set(
		createCodexTaskTools(
			{
				list: () => [],
				read: async () => ({}),
				create: async () => ({}),
				message: async () => ({}),
				interrupt: async () => ({}),
				handover: async () => ({}),
			},
			"lina",
			() => true,
		).map((t) => t.name),
	);
	const referenced = new Set(prompt.match(/lina_task_[a-z]+/g));
	expect([...referenced].sort()).toEqual([...declared].sort());
	expect(() => codexAssistantPrompt("invalid custom template")).toThrow();
});
