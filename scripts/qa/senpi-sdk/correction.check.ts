import { expect, test } from "bun:test";
import { z } from "zod";
import { exercise } from "./check-support.ts";
import { snapshotSchema, wireSchema } from "./protocol.ts";

test("a subsequent correction replaces current system context on the actual provider wire", async () => {
	// Given distinct old/new policy sentinels and completed history.
	// When the user correction is applied through the SDK session surface.
	const report = z
		.object({
			runs: z
				.array(
					z.object({
						name: z.literal("correction"),
						requests: z.array(wireSchema),
						completed: snapshotSchema,
						corrected: snapshotSchema,
					}),
				)
				.length(1),
		})
		.parse(await exercise("correction"));
	const run = report.runs[0];
	if (!run) throw new Error("Missing correction evidence");
	// Then current system input changes, while earlier conversation is not rewritten.
	expect(run.requests).toHaveLength(3);
	const previousSystem = run.requests[0]?.messages
		.filter((m) => m.role === "system")
		.map((m) => m.content);
	const currentSystem = run.requests[2]?.messages
		.filter((m) => m.role === "system")
		.map((m) => m.content);
	expect(previousSystem).toEqual(["QA_POLICY=old-policy"]);
	expect(currentSystem).toEqual(["QA_POLICY=new-policy"]);
	expect(currentSystem).not.toEqual(previousSystem);
	expect(
		run.requests[2]?.messages.filter((m) => m.role === "user").at(-1)?.content,
	).toEqual([{ type: "text", text: "QA_CORRECTION=new-policy" }]);
	expect(
		run.corrected.messages.slice(0, run.completed.messages.length),
	).toEqual(run.completed.messages);
	expect(run.corrected.messages.at(-1)?.content).toEqual([
		{ type: "text", text: "CORRECTION_DONE" },
	]);
}, 30_000);
