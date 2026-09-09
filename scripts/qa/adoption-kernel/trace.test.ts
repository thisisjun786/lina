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
	const forgedPrelude = structuredClone(trace);
	const id = `${trace.episodeId}:prelude:0`;
	forgedPrelude.effects.push({
		effectId: id,
		tool: "lookup",
		args: { key: "fabricated" },
		receipt: {
			effectId: id,
			status: "completed",
			output: { value: 7 },
			quality: { status: "unverified", verifier: null, detail: "forged" },
		},
	});
	expect(() => decodeTrace(forgedPrelude, publicCase)).toThrow();

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

test("delivery text and audience must match the completed delivery owner receipt", async () => {
	const { publicCase } = generateCase("delivery-proof", "B03", 0);
	const trace = await runEpisode(publicCase, "kernel", {
		complete: async () => ({
			kind: "ok",
			content: JSON.stringify({
				kind: "answer",
				purposeRevision: 1,
				text: "original",
			}),
			model: "fake",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
		}),
	});
	expect(decodeTrace(trace).status).toBe("complete");
	const delivery = trace.delivered[0];
	const effect = trace.effects.find((x) => x.tool === "@delivery");
	if (!delivery || !effect) throw Error("missing delivery fixture");
	for (const changed of [
		{ ...delivery, bytes: "forged correct answer" },
		{ ...delivery, audience: "public" },
	]) {
		expect(() => decodeTrace({ ...trace, delivered: [changed] })).toThrow();
	}
	expect(() =>
		decodeTrace({
			...trace,
			effects: trace.effects.map((x) =>
				x === effect ? { ...x, tool: "lookup" } : x,
			),
		}),
	).toThrow();
	expect(() =>
		decodeTrace({
			...trace,
			effects: trace.effects.map((x) =>
				x === effect
					? { ...x, receipt: { ...x.receipt, status: "unknown" } }
					: x,
			),
		}),
	).toThrow();
});

test("trace rejects internally consistent delivery without an answered decision", async () => {
	const { publicCase, privateTruth } = generateCase(
		"forged-delivery",
		"B01",
		0,
	);
	const answer = (value: string | null) =>
		JSON.stringify({
			outcome: "answer",
			value,
			missing: [],
			claims: [],
			verificationIds: [],
		});
	const trace = await runEpisode(publicCase, "kernel", {
		complete: async () => ({
			kind: "ok",
			content: JSON.stringify({
				kind: "answer",
				purposeRevision: 1,
				text: answer("wrong"),
			}),
			model: "fake",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
		}),
	});
	const bytes = answer(privateTruth.expected.value);
	trace.effects.push({
		effectId: "forged:answer",
		tool: "@delivery",
		args: { bytes, audience: "private" },
		receipt: {
			effectId: "forged:answer",
			status: "completed",
			output: { bytes, audience: "private", fence: "not-a-decision" },
			quality: { status: "unverified", verifier: null, detail: "delivery" },
		},
	});
	trace.delivered.push({
		effectId: "forged:answer",
		bytes,
		audience: "private",
		stage: 0,
	});
	expect(() => decodeTrace(trace)).toThrow();
});
