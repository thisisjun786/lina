import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorFileDigest } from "../src/author-native-policy.ts";

test("cached native fingerprints invalidate when bytes change at the same path and size", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-author-fingerprint-"));
	try {
		const file = join(root, "synthetic-binary");
		writeFileSync(file, "abc");
		const digest = authorFileDigest(file);
		expect(digest).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(authorFileDigest(file)).toBe(digest);
		writeFileSync(file, "def");
		expect(authorFileDigest(file)).not.toBe(digest);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
