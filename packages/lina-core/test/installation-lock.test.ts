import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstallationLock } from "../src/installation/lock.ts";

test("runtime and checkpoint writers exclude each other and release on close", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-lock-"));
	try {
		const first = acquireInstallationLock(root);
		expect(() => acquireInstallationLock(root)).toThrow();
		first.close();
		first.close();
		const next = acquireInstallationLock(root);
		next.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
