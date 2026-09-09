import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunMode } from "./harness-types.ts";
import { loadManifest } from "./manifest.ts";
import { scoreTrial } from "./score.ts";
import { decodeTrace } from "./trace.ts";
import { decodeTruth, type TrialScore } from "./truth.ts";

function read(path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("invalid saved artifact");
	return value as Record<string, unknown>;
}
export function rescoreBatch(
	manifestPath: string,
	root: string,
	sourceHash: string,
): {
	trials: TrialScore[];
	usage: Record<
		RunMode,
		{ requests: number; prompt: number; completion: number; latencyMs: number }
	>;
	model: string;
	baseUrl: string;
} {
	const manifest = loadManifest(manifestPath);
	const started = read(join(root, "started.json"));
	const hash = createHash("sha256")
		.update(readFileSync(manifestPath))
		.digest("hex");
	if (
		existsSync(join(root, "invalidated.json")) ||
		started["sourceHash"] !== sourceHash ||
		!/^[a-f0-9]{64}$/.test(sourceHash) ||
		started["manifestHash"] !== hash ||
		typeof started["model"] !== "string" ||
		!started["model"] ||
		typeof started["baseUrl"] !== "string" ||
		!started["baseUrl"] ||
		started["temperature"] !== 0 ||
		started["maxOutputTokens"] !== 4096 ||
		started["maxRequests"] !== 6
	)
		throw Error("invalid batch provenance or configuration");
	const trials: TrialScore[] = [];
	const usage = {
		baseline: { requests: 0, prompt: 0, completion: 0, latencyMs: 0 },
		kernel: { requests: 0, prompt: 0, completion: 0, latencyMs: 0 },
		ablation: { requests: 0, prompt: 0, completion: 0, latencyMs: 0 },
	};
	for (const episode of manifest.episodes) {
		const truth = decodeTruth(read(episode.truthPath));
		for (const mode of ["baseline", "kernel", "ablation"] as const) {
			const dir = join(root, episode.episodeId, mode);
			if (
				read(join(dir, "run.log"))["exit"] !== 0 ||
				read(join(dir, "score.log"))["exit"] !== 0
			)
				throw Error("incomplete subprocess evidence");
			const trace = decodeTrace(read(join(dir, "trace.json")));
			if (
				trace.episodeId !== episode.episodeId ||
				trace.mode !== mode ||
				trace.status !== "complete"
			)
				throw Error("trace manifest mismatch or incomplete run");
			for (const request of trace.requests) {
				if (
					request.transport.kind !== "ok" ||
					request.transport.model !== started["model"] ||
					request.transport.usage.completion > 4096
				)
					throw Error("model receipt mismatch or failure");
				usage[mode].requests++;
				usage[mode].prompt += request.transport.usage.prompt;
				usage[mode].completion += request.transport.usage.completion;
				usage[mode].latencyMs += request.transport.latencyMs;
			}
			trials.push(scoreTrial(truth, trace));
		}
	}
	return {
		trials,
		usage,
		model: started["model"],
		baseUrl: started["baseUrl"],
	};
}
