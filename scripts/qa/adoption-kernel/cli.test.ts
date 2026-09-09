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
