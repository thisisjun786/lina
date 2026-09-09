import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBatch } from "./scenario-export.ts";

test("export writes public cases separately from planned private subcases", () => {
	const root = mkdtempSync(join(tmpdir(), "case-export-"));
	try {
		const manifest = exportBatch("development", root);
		expect(manifest.episodes).toHaveLength(64);
		const first = manifest.episodes[0];
		if (!first) throw Error("missing episode");
		const input = JSON.parse(readFileSync(first.publicPath, "utf8"));
		const truth = JSON.parse(readFileSync(first.truthPath, "utf8"));
		expect(input.episodeId).toBe(truth.episodeId);
		expect(input.seed).toBeUndefined();
		expect(input.expected).toBeUndefined();
		expect(manifest.episodes.filter((e) => e.row === "B15")).toHaveLength(8);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
