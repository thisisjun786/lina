import { expect, test } from "bun:test";
import { CodexHost } from "../../lina-codex/src/host.ts";
import { createImageTools } from "../src/images/tools.ts";

test("Codex registers image tools with explicit provider/model and rejects unowned/no-request input", async () => {
	let starts = 0;
	const jobs = {
		connect: async () => ({
			ready: false,
			lanes: [],
			baseUrl: "http://127.0.0.1:45678",
			version: "3.14.0",
			generationVerified: [],
			recoveryError: null,
			ownership: "external" as const,
			setupUrl: "http://127.0.0.1:45678",
		}),
		list: () => [],
		get: () => {
			throw Error("not found");
		},
		start: async () => {
			starts++;
			throw Error("should not execute");
		},
		wait: async () => {
			throw Error("unused");
		},
		reconcile: async () => {
			throw Error("not found");
		},
		cancel: async () => {
			throw Error("not found");
		},
	};
	const tools = createImageTools(jobs, () => undefined);
	const host = new CodexHost("/tmp", () => ({ action: "allow" }));
	for (const tool of tools) host.registerTool(tool);
	expect(host.tools.has("lina_image_generate")).toBe(true);
	const generate = host.tools.get("lina_image_generate");
	if (!generate) throw Error("missing tool");
	await expect(
		generate.execute(
			"call",
			{ provider: "api", model: "image", prompt: "hello" },
			new AbortController().signal,
		),
	).rejects.toThrow("active request");
	expect(starts).toBe(0);
});
