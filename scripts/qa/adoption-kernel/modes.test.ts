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

test("baseline history reprojects privacy when a later purpose becomes public", async () => {
	const first = publicCase.stages[0];
	if (!first) throw Error("missing fixture");
	const input: PublicCase = {
		...publicCase,
		stages: [
			{
				...first,
				events: [
					{
						kind: "observe",
						evidence: {
							id: "private-e",
							revision: 1,
							subject: "s",
							domain: "real",
							visibility: "private",
							text: "PRIVATE_HISTORY_CANARY",
							active: true,
							sourceOwner: "user",
							sourceId: "secret",
							parents: [],
							participantRole: "recipient",
							quality: {
								status: "unverified",
								verifier: null,
								detail: "source",
							},
						},
					},
				],
			},
			{
				purpose: { ...first.purpose, revision: 2, audience: "public" },
				events: [],
				advanceOn: "noop",
			},
		],
	};
	for (const mode of ["baseline", "kernel", "ablation"] as const) {
		const session = createSession(mode, input, {
			complete: async (messages) => {
				const data = JSON.parse(messages[1]?.content ?? "");
				return {
					kind: "ok",
					content: JSON.stringify({
						kind: "noop",
						purposeRevision: data.purpose.revision,
						reason: "ok",
					}),
					model: "fake",
					usage: { prompt: 1, completion: 1 },
					latencyMs: 0,
				};
			},
		});
		try {
			session.applyStage(0);
			await session.step();
			session.applyStage(1);
			await session.step();
			expect(
				session.trace.requests[1]?.input.messages[1]?.content,
			).not.toContain("PRIVATE_HISTORY_CANARY");
		} finally {
			session.close();
		}
	}
});

test("baseline retains explicit retraction history while current kernel excludes source", async () => {
	const first = publicCase.stages[0];
	if (!first) throw Error("missing fixture");
	const evidence = {
		id: "raw-e",
		revision: 1,
		subject: "s",
		domain: "real" as const,
		visibility: "private" as const,
		text: "obsolete fact",
		active: true,
		sourceOwner: "user",
		sourceId: "raw-source",
		parents: [],
		participantRole: "recipient" as const,
		quality: {
			status: "unverified" as const,
			verifier: null,
			detail: "source",
		},
	};
	const input: PublicCase = {
		...publicCase,
		stages: [
			{ ...first, events: [{ kind: "observe", evidence }] },
			{
				purpose: { ...first.purpose, revision: 2 },
				events: [
					{ kind: "retract", actor: "user", id: evidence.id, revision: 2 },
				],
				advanceOn: "noop",
			},
		],
	};
	for (const mode of ["baseline", "kernel"] as const) {
		const session = createSession(mode, input, {
			complete: async () => ({
				kind: "ok",
				content: '{"kind":"noop","purposeRevision":2,"reason":"ok"}',
				model: "fake",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			}),
		});
		try {
			session.applyStage(0);
			session.applyStage(1);
			await session.step();
			const raw = JSON.parse(
				session.trace.requests[0]?.input.messages[1]?.content ?? "",
			).raw as { kind: string }[];
			expect(raw.some((x) => x.kind === "retraction")).toBe(
				mode === "baseline",
			);
		} finally {
			session.close();
		}
	}
});

test("later private purpose can access a raw source hidden during an earlier public purpose", async () => {
	const first = publicCase.stages[0];
	if (!first) throw Error("missing fixture");
	const input: PublicCase = {
		...publicCase,
		stages: [
			{
				...first,
				purpose: { ...first.purpose, audience: "public" },
				events: [
					{
						kind: "observe",
						evidence: {
							id: "private-later",
							revision: 1,
							subject: "s",
							domain: "real",
							visibility: "private",
							text: "LATER_PRIVATE_DATA",
							active: true,
							sourceOwner: "user",
							sourceId: "private-source",
							parents: [],
							participantRole: "recipient",
							quality: { status: "unverified", verifier: null, detail: "raw" },
						},
					},
				],
			},
			{
				purpose: { ...first.purpose, revision: 2, audience: "private" },
				events: [],
				advanceOn: "noop",
			},
		],
	};
	for (const mode of ["baseline", "kernel", "ablation"] as const) {
		const session = createSession(mode, input, {
			complete: async (messages) => ({
				kind: "ok",
				content: JSON.stringify({
					kind: "noop",
					purposeRevision: JSON.parse(messages[1]?.content ?? "").purpose
						.revision,
					reason: "ok",
				}),
				model: "fake",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			}),
		});
		try {
			session.applyStage(0);
			await session.step();
			session.applyStage(1);
			await session.step();
			expect(
				session.trace.requests[0]?.input.messages[1]?.content,
			).not.toContain("LATER_PRIVATE_DATA");
			expect(session.trace.requests[1]?.input.messages[1]?.content).toContain(
				"LATER_PRIVATE_DATA",
			);
		} finally {
			session.close();
		}
	}
});

test("receipt and delivery histories match across modes after normalizing host IDs", async () => {
	const first = publicCase.stages[0];
	if (!first) throw Error("missing fixture");
	const input: PublicCase = {
		...publicCase,
		stages: [
			first,
			{
				purpose: { ...first.purpose, revision: 2, text: "acknowledge history" },
				events: [],
				advanceOn: "noop",
			},
		],
	};
	const outputs: string[] = [];
	for (const mode of ["baseline", "kernel", "ablation"] as const) {
		let calls = 0;
		const session = createSession(mode, input, {
			complete: async () => ({
				kind: "ok",
				content: JSON.stringify(
					++calls === 1
						? {
								kind: "tool",
								purposeRevision: 1,
								tool: "lookup",
								args: { key: "a" },
							}
						: calls === 2
							? { kind: "answer", purposeRevision: 1, text: "value seven" }
							: { kind: "noop", purposeRevision: 2, reason: "done" },
				),
				model: "fake",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			}),
		});
		try {
			session.applyStage(0);
			await session.step();
			await session.step();
			session.applyStage(1);
			await session.step();
			const request = session.trace.requests[2];
			if (!request) throw Error("no final input");
			outputs.push(stripHostMetadata(request.input));
		} finally {
			session.close();
		}
	}
	expect(outputs[1]).toBe(outputs[0]);
	expect(outputs[2]).toBe(outputs[0]);
	expect(outputs[0]).toContain("value seven");
});
