import { expect, test } from "bun:test";

test("CLI help exposes separated generation run and scoring commands", async () => {
	const child = Bun.spawn(
		["bun", new URL("./cli.ts", import.meta.url).pathname, "--help"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const output = await new Response(child.stdout).text();
	expect(await child.exited).toBe(0);
	expect(output).toContain("export");
	expect(output).toContain("run");
	expect(output).toContain("score");
});
test("CLI refuses model execution with missing explicit configuration", async () => {
	const child = Bun.spawn(
		[
			"bun",
			new URL("./cli.ts", import.meta.url).pathname,
			"run",
			"--case",
			"missing.json",
			"--mode",
			"kernel",
			"--output",
			"/tmp/missing-config-case",
		],
		{
			env: { PATH: process.env["PATH"] ?? "" },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const error = await new Response(child.stderr).text();
	expect(await child.exited).not.toBe(0);
	expect(error).toContain("OLLAMA");
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "./manifest.ts";
import { RunRegistry } from "./run-registry.ts";

test("CLI freeze and fresh export create two distinct registered batches", async () => {
	const root = mkdtempSync(join(tmpdir(), "cli-fresh-"));
	const execute = async (args: string[]) => {
		const child = Bun.spawn(
			["bun", new URL("./cli.ts", import.meta.url).pathname, ...args],
			{
				env: { PATH: process.env["PATH"] ?? "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	};
	try {
		const freeze = join(root, "freeze.json");
		const registryPath = join(root, "registry.sqlite");
		expect((await execute(["freeze", "--output", freeze])).code).toBe(0);
		expect((await execute(["freeze", "--output", freeze])).code).not.toBe(0);
		const seeds: string[] = [];
		for (let index = 0; index < 2; index++) {
			const directory = join(root, `batch-${index}`);
			const result = await execute([
				"export-fresh",
				"--freeze",
				freeze,
				"--registry",
				registryPath,
				"--output",
				directory,
			]);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("64 fresh episodes");
			const manifest = loadManifest(join(directory, "manifest.json"));
			expect(manifest.purpose).toBe("qualification");
			seeds.push(manifest.seed);
		}
		expect(new Set(seeds).size).toBe(2);
		const registry = new RunRegistry(registryPath);
		try {
			for (const seed of seeds)
				expect(registry.generation(seed)?.manifestHash).toMatch(
					/^[a-f0-9]{64}$/,
				);
		} finally {
			registry.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
