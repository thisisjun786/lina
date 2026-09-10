import { expect, test } from "bun:test";
import { z } from "zod";
import { exercise } from "./check-support.ts";
import { snapshotSchema, wireSchema } from "./protocol.ts";

for (const [scenario, expectedEffects] of [
	["crash-fenced", 1],
	["crash-unfenced", 2],
]) {
	if (typeof scenario !== "string" || typeof expectedEffects !== "number")
		throw new Error("Invalid case");
	test(`${scenario}: SIGKILL after owner commit exposes replay effects`, async () => {
		// Given a completed conversation and a distinct operation whose owner commits before tool return.
		// When that process is killed at its exact commit IPC and a fresh session is explicitly prompted to retry.
		const report = z
			.object({
				runs: z
					.array(
						z.object({
							name: z.string(),
							requests: z.array(wireSchema),
							completed: snapshotSchema,
							reopened: snapshotSchema,
							replayed: snapshotSchema,
							killed: z.object({ signal: z.literal("SIGKILL") }),
							requestsAtOpen: z.number(),
							before: z.object({
								attempts: z.array(
									z.object({ operationId: z.string(), applied: z.number() }),
								),
								effects: z.array(z.object({ operationId: z.string() })),
							}),
							after: z.object({
								attempts: z.array(
									z.object({ operationId: z.string(), applied: z.number() }),
								),
								effects: z.array(z.object({ operationId: z.string() })),
							}),
						}),
					)
					.length(1),
			})
			.parse(await exercise(scenario));
		const run = report.runs[0];
		if (!run) throw new Error("Missing crash evidence");
		// Then SDK history and owner effects are measured separately; disabling the fence doubles the effect.
		expect(run.name).toBe(scenario);
		expect(
			run.before.effects.filter((r) => r.operationId === "operation-crash"),
		).toHaveLength(1);
		expect(
			run.after.effects.filter((r) => r.operationId === "operation-crash"),
		).toHaveLength(expectedEffects);
		expect(
			run.after.attempts
				.filter((r) => r.operationId === "operation-crash")
				.map((r) => r.applied),
		).toEqual([1, expectedEffects - 1]);
		expect(run.reopened.pid).not.toBe(run.completed.pid);
		expect(run.reopened.streaming).toBe(false);
		expect(
			run.reopened.messages.slice(0, run.completed.messages.length),
		).toEqual(run.completed.messages);
		expect(run.reopened.messages.at(-1)?.role).toBe("assistant");
		expect(run.reopened.messages.at(-1)?.stopReason).toBe("toolUse");
		expect(
			run.reopened.messages.filter((m) => m.role === "toolResult"),
		).toHaveLength(1);
		expect(run.requestsAtOpen).toBe(3);
		expect(run.requests).toHaveLength(5);
		expect(run.replayed.messages.at(-1)?.content).toEqual([
			{ type: "text", text: "REPLAY_DONE" },
		]);
	}, 30_000);
}
