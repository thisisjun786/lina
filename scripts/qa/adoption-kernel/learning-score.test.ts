import { expect, test } from "bun:test";
import { runEpisode } from "./runner.ts";
import { generateCase } from "./scenarios.ts";
import { scoreTrial } from "./score.ts";
import { decodeTrace } from "./trace.ts";

for (const condition of ["always", '{"method":"wrong","when":"wrong"}']) {
	test(`B12 rejects ungrounded condition ${condition}`, async () => {
		const generated = generateCase("learning-score", "B12", 0);
		let calls = 0;
		const trace = await runEpisode(generated.publicCase, "kernel", {
			complete: async (messages) => {
				calls++;
				const body = JSON.parse(messages[1]?.content ?? "");
				const check = body.raw.find(
					(r: { owner: string }) => r.owner === "tool:check",
				);
				if (!check) throw Error("missing failed check");
				return {
					kind: "ok",
					model: "fixture",
					usage: { prompt: 1, completion: 1 },
					latencyMs: 0,
					content: JSON.stringify(
						calls === 1
							? {
									kind: "adopt",
									purposeRevision: body.purpose.revision,
									adoptionKind: "understanding",
									text: "method rule",
									refs: [check.ref],
									condition,
								}
							: {
									kind: "answer",
									purposeRevision: body.purpose.revision,
									text: JSON.stringify({
										outcome: "answer",
										value: generated.privateTruth.expected.value,
										missing: [],
										claims: [],
										verificationIds: [],
									}),
								},
					),
				};
			},
		});
		expect(trace.status).toBe("complete");
		expect(scoreTrial(generated.privateTruth, trace).quality).toBe(true);
		expect(scoreTrial(generated.privateTruth, trace).uptake).toBe(false);
	});
}

for (const row of ["B11", "B12"]) {
	test(`${row} accepts the original conditional rule with actual grounded uptake`, async () => {
		const generated = generateCase("valid-learning", row, 0);
		const rule = generated.privateTruth.expected.learnedRule;
		if (!rule) throw Error("missing rule");
		let calls = 0;
		const trace = await runEpisode(generated.publicCase, "kernel", {
			complete: async (messages) => {
				calls++;
				const body = JSON.parse(messages[1]?.content ?? "");
				const checks = body.raw.filter(
					(r: { owner: string }) => r.owner === "tool:check",
				);
				const check = checks.at(-1);
				let action: unknown;
				if (calls === 1)
					action = {
						kind: "adopt",
						purposeRevision: body.purpose.revision,
						adoptionKind: "understanding",
						text: "conditional method failure",
						condition: JSON.stringify(rule),
						refs: [check.ref],
					};
				else if (row === "B11" && calls === 2) {
					const event = generated.publicCase.stages[1]?.events[0];
					if (!event || event.kind === "retract") throw Error("missing task");
					const task = JSON.parse(event.evidence.text);
					action = {
						kind: "tool",
						purposeRevision: body.purpose.revision,
						tool: "submit",
						args: { taskKey: task.taskKey, items: task.required },
					};
				} else if (row === "B11" && calls === 3) {
					const submit = body.raw
						.filter((r: { owner: string }) => r.owner === "tool:submit")
						.at(-1);
					action = {
						kind: "tool",
						purposeRevision: body.purpose.revision,
						tool: "check",
						args: { submissionId: JSON.parse(submit.text).effectId },
					};
				} else
					action = {
						kind: "answer",
						purposeRevision: body.purpose.revision,
						text: JSON.stringify({
							outcome: "answer",
							value: generated.privateTruth.expected.value,
							missing: [],
							claims: [],
							verificationIds:
								row === "B11" ? [JSON.parse(check.text).effectId] : [],
						}),
					};
				return {
					kind: "ok",
					model: "fixture",
					usage: { prompt: 1, completion: 1 },
					latencyMs: 0,
					content: JSON.stringify(action),
				};
			},
		});
		expect(trace.status).toBe("complete");
		const result = scoreTrial(generated.privateTruth, trace);
		expect(result.quality).toBe(true);
		expect(result.uptake).toBe(true);
		expect(decodeTrace(trace).status).toBe("complete");
		const wrongEffect = structuredClone(trace);
		const deliveryEffect = wrongEffect.effects.find(
			(effect) => effect.tool === "@delivery",
		);
		if (!deliveryEffect) throw Error("missing delivery effect");
		deliveryEffect.args = { bytes: "forged", audience: "private" };
		if (
			deliveryEffect.receipt.output &&
			typeof deliveryEffect.receipt.output === "object" &&
			!Array.isArray(deliveryEffect.receipt.output)
		)
			deliveryEffect.receipt.output["bytes"] = "forged";
		for (const delivery of wrongEffect.delivered)
			if (delivery.effectId === deliveryEffect.effectId)
				delivery.bytes = "forged";
		expect(() => decodeTrace(wrongEffect)).toThrow();

		const reused = structuredClone(trace);
		const answeredStep = reused.steps.find(
			(step) => step.kernel.status === "answered",
		);
		if (!answeredStep) throw Error("missing answer");
		answeredStep.requestIndex = 0;
		expect(() => decodeTrace(reused)).toThrow();
		const wrongStatus = structuredClone(trace);
		const firstStep = wrongStatus.steps[0];
		if (!firstStep) throw Error("missing first step");
		firstStep.kernel.status = "noop";
		expect(() => decodeTrace(wrongStatus)).toThrow();

		const crossStatus = structuredClone(trace);
		const sourceStep = crossStatus.steps[0];
		if (!sourceStep) throw Error("missing step");
		crossStatus.steps.push({
			...sourceStep,
			kernel: { status: "noop", decisionId: sourceStep.kernel.decisionId },
		});
		expect(() => decodeTrace(crossStatus)).toThrow();

		const duplicated = structuredClone(trace);
		const originalAdoption = duplicated.adoptions[0];
		if (!originalAdoption) throw Error("missing original adoption");
		duplicated.adoptions.push({
			...originalAdoption,
			id: "fabricated-adoption",
		});
		expect(() => decodeTrace(duplicated)).toThrow();
		const reusedRequest = structuredClone(trace);
		const adoptedStep = reusedRequest.steps.find(
			(step) => step.kernel.status === "adopted",
		);
		if (!adoptedStep) throw Error("missing adopted step");
		reusedRequest.steps.push({
			...adoptedStep,
			kernel: { ...adoptedStep.kernel, decisionId: "fabricated-decision" },
		});
		expect(() => decodeTrace(reusedRequest)).toThrow();

		const forgedProposal = structuredClone(trace);
		const firstRequest = forgedProposal.requests[0];
		if (firstRequest?.transport.kind !== "ok")
			throw Error("missing adopt request");
		const proposed = JSON.parse(firstRequest.transport.content);
		proposed.condition = "always";
		firstRequest.proposal = proposed;
		expect(() => decodeTrace(forgedProposal)).toThrow();
		firstRequest.transport.content = JSON.stringify(proposed);
		expect(() => decodeTrace(forgedProposal)).toThrow();

		const missingRefs = structuredClone(trace);
		for (const request of missingRefs.requests.filter(
			(r) => r.stage === generated.privateTruth.expected.finalStage,
		)) {
			const message = request.input.messages[1];
			if (!message) throw Error("missing final input");
			const body = JSON.parse(message.content);
			for (const adoption of body.derived) adoption.refs = [];
			message.content = JSON.stringify(body);
		}
		expect(scoreTrial(generated.privateTruth, missingRefs).uptake).toBe(false);

		if (row === "B11") {
			const reversed = structuredClone(trace);
			const submit = reversed.effects.filter((e) => e.tool === "submit").at(-1);
			const check = reversed.effects.filter((e) => e.tool === "check").at(-1);
			if (!submit || !check) throw Error("missing final tools");
			check.receipt.status = "failed";
			reversed.effects = [
				...reversed.effects.filter((e) => e !== submit && e !== check),
				check,
				submit,
			];
			expect(scoreTrial(generated.privateTruth, reversed).quality).toBe(false);
		}
		if (row === "B12") {
			const changedInput = structuredClone(trace);
			const request = changedInput.requests.at(-1);
			const message = request?.input.messages[1];
			if (!message) throw Error("missing final input");
			const body = JSON.parse(message.content);
			for (const raw of body.raw) {
				if (raw.owner !== "user") continue;
				const task = JSON.parse(raw.text);
				if (task.condition === generated.privateTruth.expected.taskCondition) {
					task.condition = rule.when;
					raw.text = JSON.stringify(task);
				}
			}
			message.content = JSON.stringify(body);
			expect(scoreTrial(generated.privateTruth, changedInput).uptake).toBe(
				false,
			);
		}

		const wrongAnswer = structuredClone(trace);
		const delivery = wrongAnswer.delivered.at(-1);
		if (!delivery) throw Error("missing answer");
		const decoded = JSON.parse(delivery.bytes);
		decoded.value = "WRONG";
		delivery.bytes = JSON.stringify(decoded);
		expect(scoreTrial(generated.privateTruth, wrongAnswer).quality).toBe(false);
		expect(scoreTrial(generated.privateTruth, wrongAnswer).uptake).toBe(true);

		const changed = structuredClone(trace);
		const adoption = changed.adoptions[0];
		if (!adoption) throw Error("missing adoption");
		adoption.condition = JSON.stringify({ ...rule, extra: "not allowed" });
		expect(scoreTrial(generated.privateTruth, changed).uptake).toBe(false);
		adoption.condition = JSON.stringify(rule);
		const check = changed.effects.find(
			(e) => e.effectId === `${trace.episodeId}:prelude:1`,
		);
		if (!check) throw Error("missing original check");
		check.receipt.output = {};
		expect(scoreTrial(generated.privateTruth, changed).uptake).toBe(false);
	});
}
