import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runContextEngineChecks } from "../../../scripts/qa/context-engines.ts";

const script = resolve(
	import.meta.dir,
	"../../../scripts/qa/context-engines.ts",
);
test("QA list is stateless and unknown/live arguments reject before execution", () => {
	const root = mkdtempSync(join(tmpdir(), "lina-qa-args-"));
	try {
		const list = Bun.spawnSync([process.execPath, script, "--list"], {
			cwd: root,
			env: { PATH: process.env["PATH"], TMPDIR: root },
		});
		expect(list.exitCode).toBe(0);
		expect(JSON.parse(list.stdout.toString()).actualModelQualification).toBe(
			"not_run",
		);
		for (const arg of ["--live", "--bogus"]) {
			const rejected = Bun.spawnSync([process.execPath, script, arg], {
				cwd: root,
			});
			expect(rejected.exitCode).not.toBe(0);
			expect(rejected.stderr.toString()).toContain("Unsupported argument");
		}
		expect(readdirSync(root)).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("QA preserves a failing child result and its logs without live qualification", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-qa-failure-"));
	let artifact: string | undefined;
	try {
		const result = await runContextEngineChecks(root);
		artifact = result.artifactRoot;
		expect(result.exitCode).not.toBe(0);
		expect(result.status).toBe("completed");
		expect(result.actualModelQualification).toBe("not_run");
		expect(existsSync(join(artifact, "stderr.log"))).toBe(true);
		const saved = JSON.parse(
			readFileSync(join(artifact, "result.json"), "utf8"),
		);
		expect(saved.exitCode).toBe(result.exitCode);
		expect(saved.status).toBe("completed");
		expect(existsSync(join(artifact, "runtime"))).toBe(false);
	} finally {
		if (artifact) rmSync(artifact, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("QA interruption records uncertainty and cleans its temporary runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-qa-interrupt-"));
	let artifact: string | undefined;
	try {
		const result = await runContextEngineChecks(root, AbortSignal.abort());
		artifact = result.artifactRoot;
		expect(result.status).toBe("interrupted");
		expect(result.signal).toBe("SIGTERM");
		expect(result.exitCode).not.toBe(0);
		expect(existsSync(join(artifact, "runtime"))).toBe(false);
		const saved = JSON.parse(
			readFileSync(join(artifact, "result.json"), "utf8"),
		);
		expect(saved.status).toBe("interrupted");
	} finally {
		if (artifact) rmSync(artifact, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("QA distinguishes unavailable execution from a completed failing suite", async () => {
	const root = mkdtempSync(join(tmpdir(), "lina-qa-unavailable-"));
	let artifact: string | undefined;
	try {
		const result = await runContextEngineChecks(join(root, "missing"));
		artifact = result.artifactRoot;
		expect(result.status).toBe("unavailable");
		expect(result.exitCode).not.toBe(0);
		const saved = JSON.parse(
			readFileSync(join(artifact, "result.json"), "utf8"),
		);
		expect(saved.error).toBeString();
		expect(existsSync(join(artifact, "runtime"))).toBe(false);
	} finally {
		if (artifact) rmSync(artifact, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});
