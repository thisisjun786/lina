import { expect, test } from "bun:test";
import { runEpisode } from "./runner.ts";
import { generateCase } from "./scenarios.ts";
import { decodeTrace } from "./trace.ts";

test("trace decoder rejects unknown modes and mismatched effect identities", async () => {
	const { publicCase } = generateCase("trace", "B03", 0);
	const trace = await runEpisode(publicCase, "kernel", {
		complete: async () => ({
			kind: "ok",
			content: JSON.stringify({
				kind: "answer",
				purposeRevision: 1,
				text: "hello",
			}),
			model: "fake",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
		}),
	});
	expect(decodeTrace(trace).episodeId).toBe(trace.episodeId);
	expect(() => decodeTrace({ ...trace, mode: "oracle" })).toThrow();
	const effect = trace.effects[0];
	if (!effect) throw Error("missing effect");
	expect(() =>
		decodeTrace({
			...trace,
			effects: [
				{ ...effect, receipt: { ...effect.receipt, effectId: "forged" } },
			],
		}),
	).toThrow();
	expect(() =>
		decodeTrace({
			...trace,
			requests: [
				{
					...trace.requests[0],
					transport: {
						kind: "ok",
						content: "x",
						model: "fake",
						usage: { prompt: -1, completion: 2 },
						latencyMs: 0,
					},
				},
			],
		}),
	).toThrow();
});
