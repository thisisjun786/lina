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

test("runtime resource guidance names registered Lina tools without an external memory engine", async () => {
	const { CodexHost } = await import("../../lina-codex/src/host.ts"),
		{ ResourceStore } = await import(
			"../../lina-memory/src/resources/store.ts"
		),
		{ installResourceTools } = await import("../src/resources/tools.ts"),
		{ mkdtempSync, rmSync } = await import("node:fs"),
		{ tmpdir } = await import("node:os"),
		{ join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "lina-prompt-resources-")),
		store = new ResourceStore(root, {
			maxFileBytes: 4096,
			maxCatalogBytes: 8192,
			maxExtractionBytes: 4096,
		});
	try {
		const host = new CodexHost(root, () => ({ action: "allow" }));
		installResourceTools(host.asLinaHost(), {
			store,
			scope: () => ({
				principalId: "external",
				agentId: null,
				allowedVisibilities: ["shared"],
			}),
		});
		const prompt = codexAssistantPrompt(
			readFileSync("data/app-system-prompt.md", "utf8"),
		);
		expect([...new Set(prompt.match(/lina_resource_[a-z_]+/g))].sort()).toEqual(
			[...host.tools.keys()].sort(),
		);
		expect(prompt).not.toMatch(/OpenViking|Honcho|lina_work_/);
	} finally {
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
