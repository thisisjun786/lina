import { spawn } from "node:child_process";
import {
	createWriteStream,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const contextEngineScenarios = [
	[
		"routing",
		"packages/lina-runtime/test/model-routes.test.ts",
		"packages/lina-opencodex/test/services.test.ts",
	],
	[
		"memory",
		"packages/lina-memory/test/engine-reasoning.test.ts",
		"packages/lina-memory/test/consolidation.test.ts",
		"packages/lina-runtime/test/memory-query.test.ts",
		"packages/lina-runtime/test/memory-consolidation.test.ts",
	],
	[
		"persona",
		"packages/lina-runtime/test/persona-native-growth.test.ts",
		"packages/lina-runtime/test/persona-native-context.test.ts",
	],
	[
		"context",
		"packages/lina-runtime/test/context-tree.test.ts",
		"packages/lina-runtime/test/context-session-budget.test.ts",
		"packages/lina-runtime/test/context-budget-recovery.test.ts",
	],
	[
		"resources",
		"packages/lina-memory/test/resources-extraction.test.ts",
		"packages/lina-runtime/test/resources-routes.test.ts",
	],
	[
		"shared-memory",
		"packages/lina-memory/test/resource-memory-provenance.test.ts",
		"packages/lina-runtime/test/shared-resource-consumers.test.ts",
		"packages/lina-runtime/test/resource-memory-worker.test.ts",
	],
	[
		"world",
		"packages/lina-runtime/test/life-resource-fleet.test.ts",
		"packages/lina-runtime/test/life-publication-fleet.test.ts",
		"packages/lina-memory/test/resource-activities.test.ts",
	],
	["integration", "packages/lina-runtime/test/engine-integration.test.ts"],
	[
		"dialogue",
		"packages/lina-runtime/test/persona-first-conversation.test.ts",
		"packages/lina-runtime/test/intro-api.test.ts",
	],
] as const;

type CheckResult = {
	status: "running" | "completed" | "interrupted" | "unavailable";
	error: string | null;
	exitCode: number | null;
	signal: string | null;
	artifactRoot: string;
	actualModelQualification: "not_run";
};

/** Local source qualification only. Each selected test owns its synthetic fixtures. */
export async function runContextEngineChecks(
	sourceRoot: string,
	signal?: AbortSignal,
): Promise<CheckResult> {
	const artifactRoot = mkdtempSync(
		join(tmpdir(), "lina-context-qualification-"),
	);
	const runtime = join(artifactRoot, "runtime");
	mkdirSync(runtime);
	const paths = contextEngineScenarios.flatMap(([, ...files]) => files);
	const command = [process.execPath, "test", ...paths.map((p) => `./${p}`)];
	let commit: string | null = null,
		sourceDirty: boolean | null = null;
	try {
		const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			cwd: sourceRoot,
		});
		const dirty = Bun.spawnSync(["git", "status", "--porcelain"], {
			cwd: sourceRoot,
		});
		if (source.exitCode === 0) commit = source.stdout.toString().trim();
		if (dirty.exitCode === 0)
			sourceDirty = Boolean(dirty.stdout.toString().trim());
	} catch {
		/* Missing source or Git is reported as unknown provenance; spawn reports execution failure. */
	}
	const result: CheckResult = {
		status: "running",
		error: null,
		exitCode: null,
		signal: null,
		artifactRoot,
		actualModelQualification: "not_run",
	};
	const record = () => {
		const target = join(artifactRoot, "result.json");
		writeFileSync(
			`${target}.tmp`,
			JSON.stringify(
				{
					...result,
					sourceRoot,
					commit,
					dirty: sourceDirty,
					command,
					scenarios: contextEngineScenarios,
					recordedAt: new Date().toISOString(),
					scope:
						"local synthetic DB/HTTP/RPC subset; env-gated tests are not enabled; inspect stderr.log for counts/skips; not model quality, installed service or hosted CI",
				},
				null,
				2,
			),
		);
		renameSync(`${target}.tmp`, target);
	};
	record();
	const stdout = createWriteStream(join(artifactRoot, "stdout.log"));
	const stderr = createWriteStream(join(artifactRoot, "stderr.log"));
	const child = spawn(process.execPath, command.slice(1), {
		cwd: sourceRoot,
		env: {
			PATH: process.env["PATH"] ?? "/usr/bin:/bin",
			HOME: runtime,
			TMPDIR: runtime,
			LANG: "C.UTF-8",
			TZ: "UTC",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let requested: NodeJS.Signals | undefined;
	const interrupt = (signal: NodeJS.Signals) => {
		requested = signal;
		child.kill(signal);
	};
	const sigint = () => interrupt("SIGINT"),
		sigterm = () => interrupt("SIGTERM");
	process.on("SIGINT", sigint);
	process.on("SIGTERM", sigterm);
	const abort = () => interrupt("SIGTERM");
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	child.stdout.pipe(stdout);
	child.stderr.pipe(stderr);
	try {
		await new Promise<void>((done) => {
			child.once("error", (error) => {
				result.status = "unavailable";
				result.error = error.message;
				result.exitCode = 1;
				stderr.write(`${error.message}\n`);
				stdout.end();
				stderr.end();
				done();
			});
			child.once("close", (code, signal) => {
				if (result.status === "unavailable") return done();
				result.status = signal || requested ? "interrupted" : "completed";
				result.signal = signal ?? requested ?? null;
				result.exitCode = signal || requested ? 130 : (code ?? 1);
				done();
			});
		});
		await Promise.all(
			[stdout, stderr].map(
				(stream) =>
					new Promise<void>((done, fail) => {
						if (stream.writableFinished) return done();
						stream.once("finish", done);
						stream.once("error", fail);
					}),
			),
		);
		rmSync(runtime, { recursive: true, force: true });
		record();
		return result;
	} finally {
		process.off("SIGINT", sigint);
		process.off("SIGTERM", sigterm);
		signal?.removeEventListener("abort", abort);
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--list") {
		console.log(
			JSON.stringify(
				{
					scenarios: contextEngineScenarios,
					actualModelQualification: "not_run",
				},
				null,
				2,
			),
		);
	} else if (args.length) {
		console.error(
			"Unsupported argument. Use --list or no arguments; live qualification requires separate authorization.",
		);
		process.exitCode = 2;
	} else {
		const result = await runContextEngineChecks(
			resolve(import.meta.dir, "../.."),
		);
		console.log(JSON.stringify(result));
		process.exitCode = result.exitCode ?? 1;
	}
}
