import { expect, test } from "bun:test";
import type { ModelTransport } from "./harness-types.ts";
import { runEpisode } from "./runner.ts";
import { generateCase } from "./scenarios.ts";
import { scoreTrial } from "./score.ts";

function policy(action: (revision: number) => unknown): ModelTransport {
	return {
		complete: async (messages) => {
			const body = JSON.parse(messages[1]?.content ?? "");
			return {
				kind: "ok",
				content: JSON.stringify(action(body.purpose.revision)),
				model: "negative-control",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			};
		},
	};
}
for (const row of ["B01", "B04", "B06", "B07", "B09", "B11"]) {
	test(`always-defer policy fails ${row} through the real runner`, async () => {
		const generated = generateCase("negative-control", row, 0);
		for (const mode of ["baseline", "kernel", "ablation"] as const) {
			const trace = await runEpisode(
				generated.publicCase,
				mode,
				policy((purposeRevision) => ({
					kind: "answer",
					purposeRevision,
					text: JSON.stringify({
						outcome: "defer",
						value: null,
						missing: [],
						claims: [],
						verificationIds: [],
					}),
				})),
			);
			expect(trace.requests.length).toBeGreaterThan(0);
			expect(scoreTrial(generated.privateTruth, trace).quality).toBe(false);
		}
	});
}
for (const row of ["B02", "B03", "B05", "B10"]) {
	test(`always-submit policy fails ${row} through the real runner`, async () => {
		const generated = generateCase("negative-control", row, 0);
		for (const mode of ["baseline", "kernel", "ablation"] as const) {
			const taskKey =
				Object.keys(generated.publicCase.environment.tasks)[0] ?? "nonexistent";
			const trace = await runEpisode(
				generated.publicCase,
				mode,
				policy((purposeRevision) => ({
					kind: "tool",
					purposeRevision,
					tool: "submit",
					args: { taskKey, items: [] },
				})),
			);
			expect(trace.effects.some((e) => e.tool === "submit")).toBe(true);
			expect(scoreTrial(generated.privateTruth, trace).quality).toBe(false);
		}
	});
}
