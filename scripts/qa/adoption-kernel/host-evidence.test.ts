import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHostEvidence } from "./host-evidence.ts";
import { HOST_IDS } from "./truth.ts";

test("host evidence requires every row, exact artifact bytes and row-specific execution proof", () => {
	const root = mkdtempSync(join(tmpdir(), "host-proof-"));
	const sourceHash = "a".repeat(64);
	try {
		// Synthetic validator fixtures only; these are not actual host qualification results.
		const receipts = HOST_IDS.map((id) => {
			const testName = `synthetic ${id} invariant`;
			const log = `(pass) ${testName}\n 1 pass\n 0 fail\n`;
			const artifact = join(root, `${id}.log`);
			writeFileSync(artifact, log);
			return {
				id,
				sourceHash,
				artifact,
				artifactHash: createHash("sha256").update(log).digest("hex"),
				exitCode: 0,
				command: [
					"bun",
					"test",
					"./scripts/qa/adoption-kernel/synthetic.test.ts",
					"--test-name-pattern",
					testName,
				],
				testName,
			};
		});
		expect(validateHostEvidence(receipts, sourceHash)).toHaveLength(15);
		expect(() => validateHostEvidence(receipts.slice(1), sourceHash)).toThrow();
		expect(() =>
			validateHostEvidence([...receipts, receipts[0]], sourceHash),
		).toThrow();
		expect(() => validateHostEvidence(receipts, "b".repeat(64))).toThrow();
		const first = receipts[0];
		if (!first) throw Error("missing fixture");
		expect(() =>
			validateHostEvidence(
				[{ ...first, exitCode: 1 }, ...receipts.slice(1)],
				sourceHash,
			),
		).toThrow();
		expect(() =>
			validateHostEvidence(
				[{ ...first, testName: "unexecuted" }, ...receipts.slice(1)],
				sourceHash,
			),
		).toThrow();
		writeFileSync(first.artifact, "changed");
		expect(() => validateHostEvidence(receipts, sourceHash)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
