import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	probeEvidenceRoot,
	probeExecutableIdentity,
	probeShutdown,
	probeSourceIdentity,
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

test("executable identity records the resolved build and version and rejects a failed version probe", () => {
	const root = mkdtempSync(join(tmpdir(), "moirai-version-test-"));
	try {
		const file = join(root, "native");
		const alias = join(root, "current");
		const source = '#!/bin/sh\nprintf "synthetic-native 1.2.3\\n"\n';
		writeFileSync(file, source, { mode: 0o700 });
		symlinkSync(file, alias);
		const first = probeExecutableIdentity(alias);
		expect(first).toEqual({
			path: file,
			sha256: createHash("sha256").update(source).digest("hex"),
			version: "synthetic-native 1.2.3",
		});
		writeFileSync(file, '#!/bin/sh\nprintf "synthetic-native 1.2.4\\n"\n');
		const second = probeExecutableIdentity(alias);
		expect(second.version).toBe("synthetic-native 1.2.4");
		expect(second.sha256).not.toBe(first.sha256);
		writeFileSync(file, "#!/bin/sh\nexit 3\n");
		expect(() => probeExecutableIdentity(alias)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("probe source identity changes with any included implementation and rejects missing source", () => {
	const root = mkdtempSync(join(tmpdir(), "moirai-source-identity-"));
	try {
		const a = join(root, "coordinator.ts"),
			b = join(root, "gateway.ts");
		writeFileSync(a, "first");
		writeFileSync(b, "gateway");
		const first = probeSourceIdentity([a, b]);
		expect(first.files[a]).toBe(
			createHash("sha256").update("first").digest("hex"),
		);
		writeFileSync(a, "changed");
		expect(probeSourceIdentity([a, b]).sha256).not.toBe(first.sha256);
		expect(probeSourceIdentity([b]).sha256).not.toBe(first.sha256);
		expect(() => probeSourceIdentity([join(root, "missing")])).toThrow();
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
