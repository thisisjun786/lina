import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const flow = z.object({
	name: z.literal("flow"),
	requests: z.array(
		z.object({
			messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
		}),
	),
	tool: z.object({ calls: z.number(), result: z.string() }),
	events: z.array(z.string()),
	final: z.string(),
});

test("prompt executes an allowlisted tool and returns its independent result on the wire", async () => {
	// Given an unused evidence directory and the real CLI.
	const parent = await mkdtemp(join(tmpdir(), "senpi-check-"));
	try {
		// When the CLI drives a real SDK turn.
		const child = Bun.spawn(
			[
				process.execPath,
				"run",
				"cli.ts",
				"--root",
				join(parent, "evidence"),
				"--scenario",
				"flow",
			],
			{
				cwd: import.meta.dir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		// Then evidence comes from tool execution, the following provider input, and final events.
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const report = z
			.object({ runs: z.array(flow).length(1) })
			.parse(JSON.parse(stdout));
		const run = report.runs[0];
		if (!run) throw new Error("missing flow");
		expect(run.requests).toHaveLength(2);
		expect(run.tool.calls).toBe(1);
		expect(run.tool.result).toMatch(/^owner-[0-9a-f-]+$/);
		expect(run.requests[0]?.messages.some((m) => m.role === "user")).toBe(true);
		expect(
			run.requests[1]?.messages
				.filter((m) => m.role === "tool")
				.map((m) => m.content),
		).toEqual([run.tool.result]);
		expect(run.events).toContain("tool_execution_start");
		expect(run.events).toContain("tool_execution_end");
		expect(run.events).toContain("agent_end");
		expect(run.final).toBe("FLOW_DONE");
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}, 30_000);
