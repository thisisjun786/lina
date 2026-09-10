import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	probeEvidenceRoot,
	probeShutdown,
} from "../../../scripts/qa/moirai-native-lifecycle.ts";

test("evidence root rejects relative and checkout paths before creating artifacts", () => {
	const root = mkdtempSync(join(tmpdir(), "moirai-path-test-"));
	const repository = join(root, "repository");
	try {
		mkdirSync(repository);
		mkdirSync(join(root, "repository-other"));
		expect(() => probeEvidenceRoot("relative", repository)).toThrow("absolute");
		expect(() => probeEvidenceRoot(repository, repository)).toThrow("outside");
		expect(() =>
			probeEvidenceRoot(join(repository, "artifacts"), repository),
		).toThrow("outside");
		const valid = join(root, "repository-other", "evidence");
		expect(probeEvidenceRoot(valid, repository)).toBe(valid);
		symlinkSync(root, join(root, "alias"));
		expect(() =>
			probeEvidenceRoot(
				join(root, "alias", "repository", "artifacts"),
				repository,
			),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("shutdown records a surviving owned group instead of trusting close", async () => {
	const child = spawn(
		process.execPath,
		["-e", 'process.stdout.write("ready\\n");process.stdin.resume()'],
		{
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const exited = once(child, "exit");
	try {
		await once(child.stdout, "data");
		const rpc = { pid: child.pid, async close() {} };
		expect(await probeShutdown(rpc)).toMatchObject({
			groupExited: false,
			closeError: null,
		});
		child.kill("SIGKILL");
		await exited;
		expect(await probeShutdown(rpc)).toMatchObject({
			groupExited: true,
			closeError: null,
		});
		expect(
			await probeShutdown({
				...rpc,
				async close() {
					throw Error("close failed");
				},
			}),
		).toMatchObject({
			groupExited: true,
			closeError: "close failed",
		});
	} finally {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await exited;
	}
});
