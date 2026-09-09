import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "./manifest.ts";
import { exportBatch } from "./scenario-export.ts";

test("manifest validates public/private mapping before any execution", () => {
	const root = mkdtempSync(join(tmpdir(), "manifest-"));
	try {
		const m = exportBatch("mapping", root);
		expect(loadManifest(join(root, "manifest.json")).episodes).toHaveLength(64);
		const first = m.episodes[0];
		if (!first) throw Error("missing fixture");
		first.row = "B14";
		writeFileSync(join(root, "bad.json"), JSON.stringify(m));
		expect(() => loadManifest(join(root, "bad.json"))).toThrow("mapping");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
