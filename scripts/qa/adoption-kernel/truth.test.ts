import { expect, test } from "bun:test";
import { generateCase } from "./scenarios.ts";
import { decodeTruth } from "./truth.ts";

test("private decoder rejects extra fields and incompatible variants/subcases", () => {
	const { privateTruth: t } = generateCase("decoder", "B01", 0);
	for (const bad of [
		{ ...t, extra: true },
		{ ...t, variant: -1 },
		{ ...t, variant: 4 },
		{ ...t, subcase: "omitted" },
		{ ...t, expected: { ...t.expected, role: "god" } },
		{ ...t, expected: { ...t.expected, domain: "virtual" } },
		{ ...t, expected: { ...t.expected, operation: "execute" } },
		{ ...t, expected: { ...t.expected, finalStage: -1 } },
		{ ...t, expected: { ...t.expected, extra: true } },
	])
		expect(() => decodeTruth(bad)).toThrow();
});
