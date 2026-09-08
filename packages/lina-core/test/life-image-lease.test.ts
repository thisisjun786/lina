import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireImageLease } from "../src/session-binding.ts";

test("an image manifest has one live writer, releases on close and retains its world/agent owner", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-image-owner-"));
	try {
		const first = acquireImageLease(root, "world", "lina");
		try {
			expect(() => acquireImageLease(root, "world", "lina")).toThrow();
		} finally {
			first.close();
		}
		acquireImageLease(root, "world", "lina").close();
		expect(() => acquireImageLease(root, "other", "lina")).toThrow(
			"foreign lease owner",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
