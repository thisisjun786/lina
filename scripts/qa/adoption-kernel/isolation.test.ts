import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

test("raw model execution graph contains no private evaluator or Lina engine", () => {
	const root = import.meta.dir;
	const seen = new Set<string>();
	const queue = ["runner.ts", "model.ts", "public-case.ts"].map((file) =>
		resolve(root, file),
	);
	while (queue.length) {
		const path = queue.pop();
		if (!path || seen.has(path)) continue;
		expect(path.startsWith(`${root}${sep}`)).toBe(true);
		expect([
			"truth.ts",
			"score.ts",
			"scenarios.ts",
			"scenario-export.ts",
			"compare.ts",
			"manifest.ts",
		]).not.toContain(path.slice(root.length + 1));
		seen.add(path);
		const source = readFileSync(path, "utf8");
		// All runtime imports are literal TS imports. Catch nonliteral imports separately.
		expect(source).not.toMatch(/import\s*\(\s*[^'"\s]/);
		for (const match of source.matchAll(
			/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g,
		)) {
			const specifier = match[1];
			if (!specifier) throw Error("missing import specifier");
			if (specifier.startsWith("."))
				queue.push(resolve(dirname(path), specifier));
			else expect(specifier.startsWith("node:")).toBe(true);
		}
	}
	expect(seen.has(resolve(root, "kernel.ts"))).toBe(true);
	expect(seen.has(resolve(root, "environment.ts"))).toBe(true);
	expect(seen.has(resolve(root, "store.ts"))).toBe(true);
});
