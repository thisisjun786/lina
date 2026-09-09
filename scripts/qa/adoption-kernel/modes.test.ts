import { expect, test } from "bun:test";
import type { ModelTransport, PublicCase } from "./harness-types.ts";
import { createSession } from "./modes.ts";

const publicCase: PublicCase = {
	version: 1,
	episodeId: "episode",
	stages: [
		{
			purpose: {
				id: "p",
				revision: 1,
				subject: "s",
				text: "lookup a",
				audience: "private",
				successCriteria: "answer",
				active: true,
				policyVersion: 1,
			},
			events: [],
			advanceOn: "answered",
		},
	],
	tools: [
		{ name: "lookup", description: "lookup", arguments: { key: "string" } },
	],
	environment: {
		lookups: { a: 7 },
		tasks: {},
		unavailableKeys: [],
		unknownTasks: [],
	},
	prelude: [],
};
for (const mode of ["baseline", "kernel", "ablation"] as const) {
	test(`${mode} consumes actual lookup receipt through its next model input`, async () => {
		let calls = 0;
		const transport: ModelTransport = {
			complete: async (messages) => {
				calls++;
				if (calls === 2)
					expect(messages[1]?.content).toContain('\\"value\\":7');
				return {
					kind: "ok",
					content: JSON.stringify(
						calls === 1
							? {
									kind: "tool",
									purposeRevision: 1,
									tool: "lookup",
									args: { key: "a" },
								}
							: {
									kind: "answer",
									purposeRevision: 1,
									text: '{"outcome":"answer","value":"7","missing":[],"claims":[],"verificationIds":[]}',
								},
					),
					model: "fixture",
					usage: { prompt: 1, completion: 1 },
					latencyMs: 0,
				};
			},
		};
		const session = createSession(mode, publicCase, transport);
		try {
			session.applyStage(0);
			expect((await session.step()).status).toBe("dispatched");
			expect((await session.step()).status).toBe("answered");
			expect(calls).toBe(2);
			expect(session.trace.effects.some((e) => e.tool === "lookup")).toBe(true);
			expect(session.trace.delivered).toHaveLength(1);
		} finally {
			session.close();
		}
	});
}

import { stripHostMetadata } from "./serialize.ts";

test("matched raw event histories serialize identically before mode effects diverge", async () => {
	const raw = {
		id: "00000001-source",
		revision: 1,
		subject: "s",
		domain: "real" as const,
		visibility: "private" as const,
		text: "raw datum",
		active: true,
		sourceOwner: "user",
		sourceId: "source",
		parents: [],
		participantRole: "recipient" as const,
		quality: {
			status: "unverified" as const,
			verifier: null,
			detail: "source",
		},
	};
	const initial = publicCase.stages[0];
	if (!initial) throw Error("missing fixture stage");
	const input: PublicCase = {
		...publicCase,
		stages: [
			{
				...initial,
				events: [{ kind: "observe", evidence: raw }],
			},
		],
	};
	const outputs: string[] = [];
	for (const mode of ["baseline", "kernel", "ablation"] as const) {
		const session = createSession(mode, input, {
			complete: async () => ({
				kind: "ok",
				content: JSON.stringify({
					kind: "noop",
					purposeRevision: 1,
					reason: "observed",
				}),
				model: "fake",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			}),
		});
		try {
			session.applyStage(0);
			await session.step();
			const request = session.trace.requests[0];
			if (!request) throw Error("missing request");
			outputs.push(stripHostMetadata(request.input));
		} finally {
			session.close();
		}
	}
	expect(outputs[1]).toBe(outputs[0]);
	expect(outputs[2]).toBe(outputs[0]);
});
