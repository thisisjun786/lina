import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunMode } from "./harness-types.ts";
import { loadManifest } from "./manifest.ts";
import { aggregateScores, type HostEvidence } from "./score.ts";
import { decodeTrace } from "./trace.ts";
import type { TrialScore } from "./truth.ts";
export type ComparisonReport = {
	version: 1;
	seed: string;
	trials: TrialScore[];
	runs: {
		episodeId: string;
		mode: RunMode;
		exitCode: number;
		scoreExitCode: number;
		promptTokens: number;
		completionTokens: number;
		requests: number;
		latencyMs: number;
	}[];
	qualification: ReturnType<typeof aggregateScores>;
};
async function child(
	args: string[],
	env: Record<string, string | undefined>,
	log: string,
): Promise<number> {
	const proc = Bun.spawn(
		["bun", new URL("./cli.ts", import.meta.url).pathname, ...args],
		{ env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	writeFileSync(log, JSON.stringify({ exit, stdout, stderr }));
	return exit;
}
export async function compareBatch(
	manifestPath: string,
	output: string,
	env: Record<string, string | undefined> = process.env,
	hosts: HostEvidence[] = [],
): Promise<ComparisonReport> {
	const manifest = loadManifest(manifestPath);
	const root = resolve(output);
	mkdirSync(root, { recursive: true });
	const sourceRoot = new URL(".", import.meta.url).pathname;
	const sourceHash = () => {
		const hasher = createHash("sha256");
		for (const name of readdirSync(sourceRoot)
			.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
			.sort())
			hasher.update(name).update(readFileSync(join(sourceRoot, name)));
		return hasher.digest("hex");
	};
	const originalSourceHash = sourceHash();
	const manifestHash = () =>
		createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
	const originalManifestHash = manifestHash();
	writeFileSync(
		join(root, "started.json"),
		JSON.stringify({
			sourceHash: originalSourceHash,
			model: env["OLLAMA_MODEL"],
			baseUrl: env["OLLAMA_BASE_URL"],
			temperature: 0,
			maxOutputTokens: 4096,
			maxRequests: 6,
			manifestHash: originalManifestHash,
			startedAt: new Date().toISOString(),
		}),
		{ flag: "wx" },
	);
	const report: ComparisonReport = {
		version: 1,
		seed: manifest.seed,
		trials: [],
		runs: [],
		qualification: aggregateScores([], hosts),
	};
	const assertStable = () => {
		try {
			if (
				sourceHash() !== originalSourceHash ||
				manifestHash() !== originalManifestHash
			)
				throw Error("comparison source or manifest changed");
			loadManifest(manifestPath);
		} catch (error) {
			report.qualification.qualified = false;
			writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
			writeFileSync(
				join(root, "invalidated.json"),
				JSON.stringify({
					reason: "source, manifest or dataset changed or became unreadable",
					at: new Date().toISOString(),
					completedTrials: report.trials.length,
				}),
			);
			throw error;
		}
	};
	const modes: RunMode[] = ["baseline", "kernel", "ablation"];
	for (const [index, episode] of manifest.episodes.entries()) {
		for (let offset = 0; offset < 3; offset++) {
			const mode = modes[(index + offset) % 3];
			if (!mode) throw Error("invalid mode rotation");
			const dir = join(root, episode.episodeId, mode);
			mkdirSync(dir, { recursive: true });
			assertStable();
			const exitCode = await child(
				["run", "--case", episode.publicPath, "--mode", mode, "--output", dir],
				env,
				join(dir, "run.log"),
			);
			assertStable();
			const tracePath = join(dir, "trace.json"),
				scorePath = join(dir, "score.json");
			const scoreExitCode = await child(
				[
					"score",
					"--truth",
					episode.truthPath,
					"--trace",
					tracePath,
					"--output",
					scorePath,
				],
				env,
				join(dir, "score.log"),
			);
			assertStable();
			if (scoreExitCode !== 0) {
				report.trials.push({
					episodeId: episode.episodeId,
					row: episode.row,
					seed: manifest.seed,
					variant: episode.variant,
					subcase: episode.subcase,
					mode,
					quality: false,
					uptake: null,
					incomplete: true,
					reasons: ["execution or scoring subprocess failed"],
				});
				report.runs.push({
					episodeId: episode.episodeId,
					mode,
					exitCode,
					scoreExitCode,
					promptTokens: 0,
					completionTokens: 0,
					requests: 0,
					latencyMs: 0,
				});
			} else {
				const trace = decodeTrace(JSON.parse(readFileSync(tracePath, "utf8")));
				const score = JSON.parse(readFileSync(scorePath, "utf8")) as TrialScore;
				if (
					score.episodeId !== episode.episodeId ||
					score.mode !== mode ||
					score.seed !== manifest.seed ||
					score.row !== episode.row ||
					score.variant !== episode.variant ||
					score.subcase !== episode.subcase
				)
					throw Error("score manifest identity mismatch");
				report.trials.push(score);
				report.runs.push({
					episodeId: episode.episodeId,
					mode,
					exitCode,
					scoreExitCode,
					requests: trace.requests.length,
					promptTokens: trace.requests.reduce(
						(sum, r) =>
							sum + (r.transport.kind === "ok" ? r.transport.usage.prompt : 0),
						0,
					),
					completionTokens: trace.requests.reduce(
						(sum, r) =>
							sum +
							(r.transport.kind === "ok" ? r.transport.usage.completion : 0),
						0,
					),
					latencyMs: trace.requests.reduce(
						(sum, r) => sum + r.transport.latencyMs,
						0,
					),
				});
			}
			report.qualification = aggregateScores(report.trials, hosts);
			writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
		}
	}
	return report;
}
