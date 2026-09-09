import { expect, test } from "bun:test";
import { decodePublicCase } from "./public-case.ts";
import { generateCase } from "./scenarios.ts";
import { BEHAVIOR_IDS } from "./truth.ts";

test("generator covers all behavioral families with separate truth", () => {
	for (const row of BEHAVIOR_IDS) {
		const result = generateCase("development-seed", row, 0);
		expect(decodePublicCase(result.publicCase).episodeId).toBe(
			result.privateTruth.episodeId,
		);
		expect(result.privateTruth.row).toBe(row);
		const serialized = JSON.stringify(result.publicCase);
		expect(serialized).not.toContain('"expected"');
		expect(serialized).not.toContain('"seed"');
		expect(serialized).not.toContain('"row"');
	}
});
test("seed repeats synthetic data but opaque episode IDs are fresh", () => {
	const a = generateCase("repeat", "B01", 1),
		b = generateCase("repeat", "B01", 1);
	expect(a.privateTruth.expected).toEqual(b.privateTruth.expected);
	expect(a.publicCase.episodeId).not.toBe(b.publicCase.episodeId);
	expect(generateCase("different", "B01", 1).privateTruth.expected).not.toEqual(
		a.privateTruth.expected,
	);
});

import { createSession } from "./modes.ts";

test("experience cases begin with a real failed check available to every mode", () => {
	for (const row of ["B11", "B12"]) {
		const { publicCase } = generateCase("prelude-proof", row, 0);
		for (const mode of ["baseline", "kernel", "ablation"] as const) {
			const session = createSession(mode, publicCase, {
				complete: async () => {
					throw Error("setup must not call model");
				},
			});
			try {
				session.applyStage(0);
				expect(
					session.trace.effects.some(
						(e) => e.tool === "check" && e.receipt.quality.status === "fail",
					),
				).toBe(true);
			} finally {
				session.close();
			}
		}
	}
});
test("long-input distractors have distinct source identities", () => {
	const { publicCase } = generateCase("long-ids", "B15", 0, "omitted");
	const sources = publicCase.stages.flatMap((s) =>
		s.events.flatMap((e) =>
			e.kind === "retract" ? [] : [e.evidence.sourceId],
		),
	);
	expect(new Set(sources).size).toBe(sources.length);
});

test("B15 paired cases actually place the required source inside and outside the input cap", async () => {
	for (const subcase of ["visible", "omitted"] as const) {
		const { publicCase, privateTruth } = generateCase(
			"cap-proof",
			"B15",
			0,
			subcase,
		);
		const source = privateTruth.expected.sources[0];
		if (!source) throw Error("missing truth source");
		const session = createSession("kernel", publicCase, {
			complete: async () => ({
				kind: "ok",
				content: JSON.stringify({
					kind: "noop",
					purposeRevision: 1,
					reason: "observe cap",
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
			if (!request) throw Error("no request");
			const raw = JSON.parse(request.input.messages[1]?.content ?? "").raw as {
				sourceId: string;
			}[];
			expect(raw.some((item) => item.sourceId === source)).toBe(
				subcase === "visible",
			);
			expect(request.input.omitted.rawIds.length).toBeGreaterThan(0);
		} finally {
			session.close();
		}
	}
});
