import { readFileSync, writeFileSync } from "node:fs";
import type { RunMode } from "./harness-types.ts";

function options(argv: string[]): Map<string, string> {
	const result = new Map<string, string>();
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i],
			value = argv[i + 1];
		if (
			!key?.startsWith("--") ||
			!value ||
			value.startsWith("--") ||
			result.has(key)
		)
			throw Error("invalid CLI arguments");
		result.set(key, value);
	}
	return result;
}
function required(args: Map<string, string>, key: string): string {
	const value = args.get(key);
	if (!value) throw Error(`missing ${key}`);
	return value;
}
function env(name: string): string {
	const value = process.env[name];
	if (!value) throw Error(`missing ${name}`);
	return value;
}
export async function main(argv: string[]): Promise<void> {
	const command = argv[0];
	if (command === "--help" || command === "help") {
		process.stdout.write(
			"Independent adoption experiment\nexport --seed VALUE --output DIRECTORY\nrun --case PUBLIC_JSON --mode baseline|kernel|ablation --output DIRECTORY\nscore --truth PRIVATE_JSON --trace TRACE_JSON --output SCORE_JSON\ncompare --manifest BATCH_MANIFEST --output DIRECTORY\nrun requires OLLAMA_BASE_URL (ending /v1), OLLAMA_MODEL, OLLAMA_API_KEY. Six calls, 4096 output tokens per call.\n",
		);
		return;
	}
	const args = options(argv.slice(1));
	if (command === "compare") {
		const { compareBatch } = await import("./compare.ts");
		const report = await compareBatch(
			required(args, "--manifest"),
			required(args, "--output"),
		);
		process.stdout.write(
			`${report.trials.length} trials; qualification ${report.qualification.qualified ? "pass" : "incomplete or failed"}\n`,
		);
		return;
	}
	if (command === "export") {
		const { exportBatch } = await import("./scenario-export.ts");
		const manifest = exportBatch(
			required(args, "--seed"),
			required(args, "--output"),
		);
		process.stdout.write(`${manifest.episodes.length} episodes exported\n`);
		return;
	}
	if (command === "run") {
		const config = {
			baseUrl: env("OLLAMA_BASE_URL"),
			model: env("OLLAMA_MODEL"),
			apiKey: env("OLLAMA_API_KEY"),
			timeoutMs: 120000,
			maxOutputTokens: 4096 as const,
			temperature: 0 as const,
		};
		const mode = required(args, "--mode");
		if (!["baseline", "kernel", "ablation"].includes(mode))
			throw Error("invalid mode");
		const { decodePublicCase } = await import("./public-case.ts");
		const { createTransport } = await import("./model.ts");
		const { runEpisode } = await import("./runner.ts");
		const input = decodePublicCase(
			JSON.parse(readFileSync(required(args, "--case"), "utf8")),
		);
		const trace = await runEpisode(
			input,
			mode as RunMode,
			createTransport(config),
			required(args, "--output"),
		);
		process.stdout.write(
			`${trace.status}: ${trace.requests.length} requests\n`,
		);
		if (trace.status !== "complete") process.exitCode = 2;
		return;
	}
	if (command === "score") {
		const { decodeTruth } = await import("./truth.ts");
		const { scoreTrial } = await import("./score.ts");
		const { decodeTrace } = await import("./trace.ts");
		const truth = decodeTruth(
			JSON.parse(readFileSync(required(args, "--truth"), "utf8")),
		);
		const trace = decodeTrace(
			JSON.parse(readFileSync(required(args, "--trace"), "utf8")),
		);
		const score = scoreTrial(truth, trace);
		writeFileSync(
			required(args, "--output"),
			`${JSON.stringify(score, null, 2)}\n`,
		);
		process.stdout.write(`${score.quality ? "pass" : "fail"}\n`);
		return;
	}
	throw Error("unknown command; use --help");
}
if (import.meta.main)
	main(process.argv.slice(2)).catch(() => {
		process.stderr.write(
			"Experiment command failed: check arguments, files and explicit OLLAMA configuration.\n",
		);
		process.exitCode = 1;
	});
