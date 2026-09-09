import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRegistry } from "./run-registry.ts";

test("registry preserves begun attempts across reopen and rejects changed identity", () => {
	const root = mkdtempSync(join(tmpdir(), "run-registry-"));
	const path = join(root, "registry.sqlite");
	const entry = {
		output: join(root, "run"),
		seed: "fresh",
		purpose: "qualification" as const,
		manifestPath: join(root, "manifest.json"),
		manifestHash: "a".repeat(64),
		sourceHash: "b".repeat(64),
	};
	try {
		const first = new RunRegistry(path);
		first.begin(entry);
		first.close();
		const reopened = new RunRegistry(path);
		try {
			expect(reopened.entries()).toHaveLength(1);
			expect(reopened.entries()[0]?.state).toBe("started");
			expect(() => reopened.begin(entry)).toThrow();
			expect(() => reopened.begin({ ...entry, seed: "different" })).toThrow();
			reopened.finish(entry.output, "failed");
			expect(reopened.entries()[0]?.state).toBe("failed");
			expect(() => reopened.finish(entry.output, "completed")).toThrow();
			reopened.begin({ ...entry, output: join(root, "second") });
			expect(reopened.entries().map((e) => e.state)).toEqual([
				"failed",
				"started",
			]);
		} finally {
			reopened.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
