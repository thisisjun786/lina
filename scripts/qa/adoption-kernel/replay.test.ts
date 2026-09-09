import { expect, test } from "bun:test";
import { verifyReplay } from "./replay.ts";
import { runEpisode } from "./runner.ts";
import { generateCase } from "./scenarios.ts";

test("replay rejects evaluator fields injected into a recorded model input", async () => {
	const generated = generateCase("replay", "B01", 0);
	const trace = await runEpisode(generated.publicCase, "kernel", {
		complete: async () => ({
			kind: "ok",
			model: "fixture",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
			content: JSON.stringify({
				kind: "answer",
				purposeRevision: 1,
				text: "response",
			}),
		}),
	});
	await verifyReplay(generated.publicCase, trace);
	const modified = structuredClone(trace);
	const message = modified.requests[0]?.input.messages[1];
	if (!message) throw Error("missing model input");
	const body = JSON.parse(message.content);
	body.evaluatorOnlyExpectedAnswer = generated.privateTruth.expected.value;
	message.content = JSON.stringify(body);
	await expect(verifyReplay(generated.publicCase, modified)).rejects.toThrow();
});
