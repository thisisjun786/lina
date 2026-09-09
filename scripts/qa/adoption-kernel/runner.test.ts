import { expect, test } from "bun:test";
import type { ModelTransport, PublicCase } from "./harness-types.ts";
import { runEpisode } from "./runner.ts";

const sample: PublicCase = {
	version: 1,
	episodeId: "stages",
	stages: [
		{
			purpose: {
				id: "p",
				revision: 1,
				subject: "s",
				text: "plan",
				audience: "private",
				successCriteria: "plan",
				active: true,
				policyVersion: 1,
			},
			events: [],
			advanceOn: "adopted",
		},
		{
			purpose: {
				id: "p",
				revision: 2,
				subject: "s",
				text: "answer",
				audience: "private",
				successCriteria: "answer",
				active: true,
				policyVersion: 1,
			},
			events: [],
			advanceOn: "answered",
		},
	],
	tools: [],
	environment: {
		lookups: {},
		tasks: {},
		unavailableKeys: [],
		unknownTasks: [],
	},
	prelude: [],
};
test("public stages share one transport budget and include adopted input", async () => {
	let calls = 0;
	const transport: ModelTransport = {
		complete: async () => ({
			kind: "ok",
			content: JSON.stringify(
				++calls === 1
					? {
							kind: "adopt",
							purposeRevision: 1,
							adoptionKind: "understanding",
							text: "use method under C",
							refs: [],
							condition: "C",
						}
					: { kind: "answer", purposeRevision: 2, text: "done" },
			),
			model: "fake",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
		}),
	};
	const trace = await runEpisode(sample, "kernel", transport);
	expect(trace.status).toBe("complete");
	expect(trace.requests).toHaveLength(2);
	expect(trace.requests[1]?.input.adoptionIds).toHaveLength(1);
});
test("invalid model output stops at six calls without hidden retries", async () => {
	const transport: ModelTransport = {
		complete: async () => ({
			kind: "ok",
			content: "invalid",
			model: "fake",
			usage: { prompt: 1, completion: 1 },
			latencyMs: 0,
		}),
	};
	const trace = await runEpisode(sample, "baseline", transport);
	expect(trace.status).toBe("limit");
	expect(trace.requests).toHaveLength(6);
});

test("unknown tool outcome permits reporting on a new purpose without readmission", async () => {
	const first = sample.stages[0],
		second = sample.stages[1];
	if (!first || !second) throw Error("missing fixture stages");
	const input: PublicCase = {
		...sample,
		tools: [{ name: "submit", description: "submit task", arguments: {} }],
		environment: {
			...sample.environment,
			tasks: { t: { required: ["a"], condition: "C", methods: {} } },
			unknownTasks: ["t"],
		},
		stages: [
			{ ...first, advanceOn: "owner-unknown" },
			{
				...second,
				purpose: { ...second.purpose, id: "report", revision: 1 },
				advanceOn: "deferred",
			},
		],
	};
	for (const mode of ["baseline", "kernel", "ablation"] as const) {
		let calls = 0;
		const transport: ModelTransport = {
			complete: async () => ({
				kind: "ok",
				content: JSON.stringify(
					++calls === 1
						? {
								kind: "tool",
								purposeRevision: 1,
								tool: "submit",
								args: { taskKey: "t", items: ["a"] },
							}
						: {
								kind: "defer",
								purposeRevision: 1,
								condition: "receipt arrives",
								reason: "outcome unknown",
							},
				),
				model: "fake",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			}),
		};
		const trace = await runEpisode(input, mode, transport);
		expect(trace.status).toBe("complete");
		expect(calls).toBe(2);
		expect(trace.effects.filter((e) => e.tool === "submit")).toHaveLength(1);
		expect(trace.requests[1]?.input.messages[1]?.content).toContain("unknown");
	}
});
