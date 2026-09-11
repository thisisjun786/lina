import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "./protocol.ts";

export async function exercise(scenario: string): Promise<unknown> {
	const parent = await mkdtemp(join(tmpdir(), "senpi-check-"));
	const child = Bun.spawn(
		[
			process.execPath,
			"run",
			"cli.ts",
			"--root",
			join(parent, "evidence"),
			"--scenario",
			scenario,
		],
		{
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [code, stdout, stderr] = await bounded(
			Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]),
			"CLI check",
		);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		return JSON.parse(stdout);
	} finally {
		child.kill();
		await child.exited;
		await rm(parent, { recursive: true, force: true });
	}
}
