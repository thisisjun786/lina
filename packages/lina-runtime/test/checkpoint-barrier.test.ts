import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstallationLock } from "../../lina-core/src/installation/lock.ts";
import { acquireSessionLease } from "../../lina-core/src/session-binding.ts";
import { Fixture } from "../../lina-core/test/fixture.ts";
import { acquireCheckpointBarrier } from "../src/checkpoint-barrier.ts";

test("checkpoint barrier rejects a running fleet and releases after failure", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-checkpoint-lock-"));
	const runtime = acquireInstallationLock(root);
	try {
		expect(() => acquireCheckpointBarrier(root)).toThrow();
	} finally {
		runtime.close();
	}
	try {
		const barrier = acquireCheckpointBarrier(root);
		barrier.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("checkpoint also rejects an old runtime holding only its agent lease", () => {
	const fixture = new Fixture();
	try {
		const { root, binding } = fixture;
		const lease = fixture.keep(
			acquireSessionLease(root, binding.botId, binding.workspace),
		);
		lease.bind(binding);
		expect(() => acquireCheckpointBarrier(root)).toThrow();
		lease.close();
		const barrier = acquireCheckpointBarrier(root);
		expect(() =>
			acquireSessionLease(root, binding.botId, binding.workspace),
		).toThrow();
		barrier.close();
		fixture.keep(acquireSessionLease(root, binding.botId, binding.workspace));
	} finally {
		fixture.close();
	}
});
