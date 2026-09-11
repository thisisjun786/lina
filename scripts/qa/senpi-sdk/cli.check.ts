import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { exercise } from "./check-support.ts";
import { bounded } from "./protocol.ts";

test("all scenarios produce a single report with measured SDK identity", async () => {
	// Given the pinned SDK and independent scenario expectations.
	// When the real CLI runs the complete probe.
	const report = z
		.object({
			version: z.literal("2026.9.10-2"),
			synthetic: z.literal(true),
			runs: z.array(z.object({ name: z.string() })),
		})
		.parse(await exercise("all"));
	// Then no requested scenario is silently omitted.
	expect(report.runs.map((run) => run.name)).toEqual([
		"flow",
		"correction",
		"recovery",
		"crash-fenced",
		"crash-unfenced",
	]);
}, 30_000);

test("an unsupported scenario is rejected before creating evidence", async () => {
	// Given an unused evidence path.
	const parent = await mkdtemp(join(tmpdir(), "senpi-invalid-"));
	const root = join(parent, "evidence");
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			"cli.ts",
			"--root",
			root,
			"--scenario",
			"unsupported",
		],
		{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
	);
	try {
		// When input validation rejects the scenario.
		const [code] = await bounded(
			Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]),
			"invalid CLI",
		);
		// Then no evidence directory was created.
		expect(code).toBe(1);
		expect(existsSync(root)).toBe(false);
	} finally {
		child.kill();
		await child.exited;
		await rm(parent, { recursive: true, force: true });
	}
});
