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

test("conversation image tools reject a LIFE owner before any execution", async () => {
	const { ImageJobStore } = await import("../src/images/store.ts");
	const { ImageJobs } = await import("../src/images/jobs.ts");
	const { mkdtempSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const root = mkdtempSync(join(tmpdir(), "lina-image-tool-owner-"));
	const store = new ImageJobStore(
		root,
		{ kind: "life", worldId: "world", agentId: "agent" },
		{
			maxActiveJobs: 1,
			maxArchivedJobs: 1,
			maxActiveBytes: 100000,
			maxArchiveBytes: 100000,
			maxTotalBytes: 200000,
		},
	);
	const unreachable = async (): Promise<never> => {
		throw Error("Unexpected operation");
	};
	const jobs = new ImageJobs({
		store,
		client: {
			connect: unreachable,
			submit: unreachable,
			read: unreachable,
			cancel: unreachable,
			download: unreachable,
		},
		artifacts: {
			resolveReference: unreachable,
			preflight: unreachable,
			importOutput: unreachable,
			verify: unreachable,
		},
		completion: { complete: unreachable },
	});
	try {
		expect(() => createImageTools(jobs, () => "conversation-request")).toThrow(
			"conversation",
		);
	} finally {
		await jobs.close();
		rmSync(root, { recursive: true, force: true });
	}
});
