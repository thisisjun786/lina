import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreeze, exportFresh, readFreeze } from "./freshness.ts";
import { RunRegistry } from "./run-registry.ts";

test("fresh export binds randomly generated seed to prior frozen candidate", () => {
	const root = mkdtempSync(join(tmpdir(), "freshness-"));
	try {
		const freezePath = join(root, "freeze.json");
		const registryPath = join(root, "registry.sqlite");
		createFreeze(freezePath);
		expect(() => createFreeze(freezePath)).toThrow();
		const frozen = readFreeze(freezePath);
		const manifest = exportFresh(freezePath, registryPath, join(root, "batch"));
		expect(manifest.purpose).toBe("qualification");
		expect(manifest.episodes).toHaveLength(64);
		const registry = new RunRegistry(registryPath);
		try {
			registry.beginGeneration("interrupted", frozen.hash);
			expect(registry.generation("interrupted")?.manifestHash).toBeNull();
			expect(() =>
				registry.beginGeneration("interrupted", frozen.hash),
			).toThrow();
			const generation = registry.generation(manifest.seed);
			expect(generation?.freezeHash).toBe(frozen.hash);
			expect(generation?.manifestPath).toBe(
				join(root, "batch", "manifest.json"),
			);
			expect(
				Date.parse(generation?.startedAt ?? "") >= Date.parse(frozen.at),
			).toBe(true);
			expect(generation?.manifestHash).toMatch(/^[a-f0-9]{64}$/);
		} finally {
			registry.close();
		}
		const changed = JSON.parse(readFileSync(freezePath, "utf8"));
		changed.sourceHash = "f".repeat(64);
		writeFileSync(freezePath, JSON.stringify(changed));
		expect(() =>
			exportFresh(freezePath, registryPath, join(root, "invalid")),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
