import { expect, test } from "bun:test";
import { z } from "zod";
import { exercise } from "./check-support.ts";
import { snapshotSchema, wireSchema } from "./protocol.ts";

test("abort closes a held request and fresh-process reopening preserves completed history without auto-resume", async () => {
	// Given a completed tool conversation followed by a provider-held request.
	// When the exact held signal triggers abort, then a new OS process opens its saved session.
	const report = z
		.object({
			runs: z
				.array(
					z.object({
						name: z.literal("recovery"),
						requests: z.array(wireSchema),
						completed: snapshotSchema,
						aborted: snapshotSchema,
						reopened: snapshotSchema,
						continued: snapshotSchema,
						heldRequest: z.number(),
						disconnectedRequest: z.number(),
						requestsAtOpen: z.number(),
						unfinished: z.literal("interrupted-not-resumed-on-open"),
					}),
				)
				.length(1),
		})
		.parse(await exercise("recovery"));
	const run = report.runs[0];
	if (!run) throw new Error("Missing recovery evidence");
	// Then both cancellation and persistence have independent observable witnesses.
	expect(run.heldRequest).toBe(3);
	expect(run.disconnectedRequest).toBe(3);
	expect(run.aborted.messages.at(-1)?.stopReason).toBe("aborted");
	expect(run.aborted.streaming).toBe(false);
	expect(run.reopened.pid).not.toBe(run.completed.pid);
	expect(run.reopened.file).toBe(run.completed.file);
	expect(run.reopened.messages).toEqual(run.aborted.messages);
	expect(run.reopened.messages.slice(0, run.completed.messages.length)).toEqual(
		run.completed.messages,
	);
	expect(run.reopened.streaming).toBe(false);
	expect(run.requestsAtOpen).toBe(3);
	expect(run.requests).toHaveLength(4);
	expect(
		run.requests[3]?.messages
			.filter((m) => m.role === "tool")
			.map((m) => m.content),
	).toEqual(
		run.requests[1]?.messages
			.filter((m) => m.role === "tool")
			.map((m) => m.content),
	);
	expect(run.continued.messages.at(-1)?.content).toEqual([
		{ type: "text", text: "REOPENED_DONE" },
	]);
}, 30_000);
