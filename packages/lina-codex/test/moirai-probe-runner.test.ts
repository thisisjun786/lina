import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
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
	probeFingerprint,
	probeShutdown,
	probeSourceIdentity,
} from "../../../scripts/qa/moirai-native-lifecycle.ts";
import {
	type AuthorNativePlan,
	authorManagedFiles,
} from "../src/author-native-policy.ts";
import { lifeMetadata } from "./life-model-fixture.ts";

test("repository source identity includes lower execution dependencies and the lockfile", () => {
	const root = mkdtempSync(join(tmpdir(), "moirai-source-tree-"));
	try {
		execFileSync("git", ["init", "--quiet", root]);
		mkdirSync(join(root, "packages"));
		const entry = join(root, "probe.ts");
		const dependency = join(root, "packages", "rpc.ts");
		const lock = join(root, "bun.lock");
		writeFileSync(entry, 'import "./packages/rpc.ts";');
		writeFileSync(dependency, "original rpc");
		writeFileSync(lock, "original lock");
		execFileSync("git", ["-C", root, "add", "."]);
		const first = probeSourceIdentity(root);
		expect(first.files[dependency]).toBe(
			createHash("sha256").update("original rpc").digest("hex"),
		);
		writeFileSync(dependency, "changed rpc");
		expect(probeSourceIdentity(root).sha256).not.toBe(first.sha256);
		writeFileSync(dependency, "original rpc");
		expect(probeSourceIdentity(root).sha256).toBe(first.sha256);
		writeFileSync(lock, "changed lock");
		expect(probeSourceIdentity(root).sha256).not.toBe(first.sha256);
		writeFileSync(lock, "original lock");
		const added = join(root, "packages", "new-dependency.ts");
		writeFileSync(added, "new source");
		expect(probeSourceIdentity(root).files[added]).toBeDefined();
		expect(probeSourceIdentity(root).sha256).not.toBe(first.sha256);
		rmSync(dependency);
		expect(() => probeSourceIdentity(root)).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

for (const mutation of ["contents", "removed", "added", "retargeted"]) {
	test(`probe fingerprint rejects managed policy drift: ${mutation}`, () => {
		const root = mkdtempSync(join(tmpdir(), "moirai-policy-drift-"));
		try {
			const source = join(root, "requirements.toml");
			const alias = join(root, "policy-link");
			const added = join(root, "config.toml");
			const executable = join(root, "native");
			writeFileSync(source, 'approval_policy = "never"\n');
			writeFileSync(executable, "synthetic executable");
			symlinkSync(source, alias);
			const paths = [alias, added];
			const plan: AuthorNativePlan = {
				root,
				home: root,
				workspace: root,
				command: executable,
				wrapper: executable,
				managed: authorManagedFiles(paths),
				fingerprint: "",
				metadata: lifeMetadata,
				selection: {
					selected: {
						id: "synthetic",
						provider: "opencodex",
						model: lifeMetadata.slug,
						reasoning: "off",
					},
					connection: {
						origin: "http://127.0.0.1:1",
						baseUrl: "http://127.0.0.1:1/v1",
						catalogJson: JSON.stringify({ models: [lifeMetadata] }),
						catalogSource: "hub",
						requiresAdmissionToken: false,
						tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
						providerTable: "",
					},
				},
			};
			const fingerprint = () =>
				probeFingerprint(plan, [executable], { tools: [] }, paths);
			const first = fingerprint();
			expect(fingerprint()).toBe(first);
			const captured = structuredClone(plan.managed);
			if (mutation === "contents")
				writeFileSync(
					source,
					'approval_policy = "never"\nmodel_verbosity = "high"\n',
				);
			if (mutation === "removed") rmSync(alias);
			if (mutation === "added") writeFileSync(added, "new policy");
			if (mutation === "retargeted") {
				const other = join(root, "other.toml");
				writeFileSync(other, 'approval_policy = "never"\n');
				rmSync(alias);
				symlinkSync(other, alias);
			}
			expect(fingerprint).toThrow(
				"Administrator-managed policy changed during probe",
			);
			expect(plan.managed).toEqual(captured);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
}

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
