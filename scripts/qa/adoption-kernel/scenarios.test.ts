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
