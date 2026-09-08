import { expect, test } from "bun:test";
import {
	conservativeEstimator,
	takeBudgetPrefix,
} from "../src/context/budget.ts";

test("budget packing includes the envelope and preserves every Unicode code point", () => {
	const text = "결정😀이유🫖".repeat(30),
		envelope = (v: string) => `[source]\n${v}\n[end]`;
	let remaining = text,
		restored = "";
	while (remaining) {
		const part = takeBudgetPrefix(
			remaining,
			40,
			conservativeEstimator,
			envelope,
		);
		expect(part.length).toBeGreaterThan(0);
		expect(conservativeEstimator.text(envelope(part))).toBeLessThanOrEqual(40);
		expect(part.isWellFormed()).toBe(true);
		restored += part;
		remaining = remaining.slice(part.length);
	}
	expect(restored).toBe(text);
	expect(() =>
		takeBudgetPrefix("😀", 1, conservativeEstimator, envelope),
	).toThrow();
});
