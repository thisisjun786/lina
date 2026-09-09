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

test("qualification candidates are the last three complete fresh attempts", () => {
	const root = mkdtempSync(join(tmpdir(), "registry-candidates-"));
	const registry = new RunRegistry(join(root, "registry.sqlite"));
	const sourceHash = "b".repeat(64);
	const add = (
		seed: string,
		purpose: "development" | "qualification",
		state: "completed" | "failed" | "started" = "completed",
		source = sourceHash,
	) => {
		const output = join(root, `run-${registry.entries().length}`);
		registry.begin({
			output,
			seed,
			purpose,
			sourceHash: source,
			manifestHash: "a".repeat(64),
			manifestPath: join(root, `${seed}.json`),
		});
		if (state !== "started") registry.finish(output, state);
	};
	try {
		expect(() =>
			registry.qualificationCandidates(sourceHash, "2000-01-01T00:00:00.000Z"),
		).toThrow();
		add("development-seed", "development");
		add("first", "qualification");
		add("second", "qualification");
		add("third", "qualification");
		expect(
			registry
				.qualificationCandidates(sourceHash, "2000-01-01T00:00:00.000Z")
				.map((e) => e.seed),
		).toEqual(["first", "second", "third"]);
		expect(() =>
			registry.qualificationCandidates(sourceHash, "2999-01-01T00:00:00.000Z"),
		).toThrow();
		expect(() =>
			registry.qualificationCandidates(
				"c".repeat(64),
				"2000-01-01T00:00:00.000Z",
			),
		).toThrow();
		add("development-seed", "qualification");
		expect(() =>
			registry.qualificationCandidates(sourceHash, "2000-01-01T00:00:00.000Z"),
		).toThrow();
		add("new-a", "qualification");
		add("new-b", "qualification");
		add("new-c", "qualification", "failed");
		expect(() =>
			registry.qualificationCandidates(sourceHash, "2000-01-01T00:00:00.000Z"),
		).toThrow();
		add("new-d", "qualification", "started");
		expect(() =>
			registry.qualificationCandidates(sourceHash, "2000-01-01T00:00:00.000Z"),
		).toThrow();
	} finally {
		registry.close();
		rmSync(root, { recursive: true, force: true });
	}
});
