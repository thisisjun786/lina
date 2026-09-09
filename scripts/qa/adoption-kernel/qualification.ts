import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { candidateDigests } from "./candidate.ts";
import { readFreeze } from "./freshness.ts";
import { validateHostEvidence } from "./host-evidence.ts";
import { loadManifest } from "./manifest.ts";
import { rescoreBatch } from "./rescore.ts";
import { RunRegistry } from "./run-registry.ts";
import { aggregateScores } from "./score.ts";
import { BEHAVIOR_IDS, type TrialScore } from "./truth.ts";

function commonScore(trials: TrialScore[], mode: string): number {
	return (
		BEHAVIOR_IDS.reduce((sum, row) => {
			let passes = 0;
			for (let variant = 0; variant < 4; variant++) {
				const selected = trials.filter(
					(t) => t.mode === mode && t.row === row && t.variant === variant,
				);
				if (
					selected.length === (row === "B15" ? 2 : 1) &&
					selected.every((t) => t.quality && !t.incomplete)
				)
					passes++;
			}
			return sum + passes * 25;
		}, 0) / 15
	);
}
export async function qualify(indexPath: string) {
	const value: unknown = JSON.parse(readFileSync(indexPath, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid qualification index");
	const index = value as Record<string, unknown>;
	if (
		Object.keys(index).sort().join() !==
			[
				"version",
				"registryPath",
				"sourceHash",
				"generatorHash",
				"rubricHash",
				"frozenAt",
				"freezePath",
				"hosts",
			]
				.sort()
				.join() ||
		index["version"] !== 1 ||
		typeof index["registryPath"] !== "string" ||
		!isAbsolute(index["registryPath"]) ||
		!existsSync(index["registryPath"]) ||
		typeof index["frozenAt"] !== "string" ||
		typeof index["freezePath"] !== "string"
	)
		throw Error("invalid qualification index fields");
	const digests = candidateDigests();
	const freeze = readFreeze(index["freezePath"] as string);
	if (freeze.at !== index["frozenAt"]) throw Error("freeze time mismatch");
	for (const [key, hash] of Object.entries(digests))
		if (index[key] !== hash)
			throw Error("candidate differs from qualification freeze");
	const registry = new RunRegistry(index["registryPath"]);
	try {
		const candidates = registry.qualificationCandidates(
			digests.sourceHash,
			index["frozenAt"],
		);
		const hosts = validateHostEvidence(index["hosts"], digests.sourceHash);
		let configuration: string | null = null;
		const batches = [];
		for (const entry of candidates) {
			const manifest = loadManifest(entry.manifestPath);
			const generation = registry.generation(entry.seed);
			if (
				!generation ||
				generation.freezeHash !== freeze.hash ||
				generation.manifestPath !== entry.manifestPath ||
				generation.manifestHash !== entry.manifestHash ||
				generation.finishedAt === null ||
				!Number.isFinite(Date.parse(generation.startedAt)) ||
				!Number.isFinite(Date.parse(generation.finishedAt)) ||
				Date.parse(generation.startedAt) < Date.parse(freeze.at) ||
				Date.parse(generation.finishedAt) < Date.parse(generation.startedAt) ||
				Date.parse(generation.finishedAt) > Date.parse(entry.startedAt)
			)
				throw Error("batch was not freshly generated under candidate freeze");
			if (
				manifest.purpose !== "qualification" ||
				manifest.seed !== entry.seed ||
				createHash("sha256")
					.update(readFileSync(entry.manifestPath))
					.digest("hex") !== entry.manifestHash
			)
				throw Error("registry manifest mismatch");
			const started = JSON.parse(
				readFileSync(join(entry.output, "started.json"), "utf8"),
			);
			if (started.registryPath !== resolve(index["registryPath"] as string))
				throw Error("batch belongs to different registry");
			for (const [key, hash] of Object.entries(digests))
				if (started[key] !== hash)
					throw Error("batch candidate provenance mismatch");
			const rescored = await rescoreBatch(
				entry.manifestPath,
				entry.output,
				digests.sourceHash,
			);
			const config = JSON.stringify({
				model: rescored.model,
				baseUrl: rescored.baseUrl,
			});
			if (configuration !== null && config !== configuration)
				throw Error("batch model configuration mismatch");
			configuration = config;
			const common = {
				baseline: commonScore(rescored.trials, "baseline"),
				kernel: commonScore(rescored.trials, "kernel"),
				ablation: commonScore(rescored.trials, "ablation"),
			};
			batches.push({
				seed: entry.seed,
				output: entry.output,
				scores: aggregateScores(rescored.trials, hosts),
				common,
				kernelMinusBaseline: common.kernel - common.baseline,
				kernelMinusAblation: common.kernel - common.ablation,
				...rescored,
			});
		}
		const history = registry.entries().map((entry) => {
			const reportPath = join(entry.output, "report.json");
			let recordedReport: unknown = null;
			let evidenceStatus = "missing-or-unreadable";
			try {
				recordedReport = JSON.parse(readFileSync(reportPath, "utf8"));
				evidenceStatus = "historical-record-not-requalified";
			} catch {
				/* Missing reports remain visible as incomplete evidence. */
			}
			return { ...entry, reportPath, evidenceStatus, recordedReport };
		});
		return {
			version: 1,
			qualified: batches.every((b) => b.scores.qualified),
			...digests,
			frozenAt: index["frozenAt"],
			attempts: history.length,
			history,
			batches,
		};
	} finally {
		registry.close();
	}
}
