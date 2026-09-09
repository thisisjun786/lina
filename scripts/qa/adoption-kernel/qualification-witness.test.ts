// Test-only omniscient action witnesses validate evaluator reachability, never model ability.
// This file is not imported by CLI/runtime; its access to private truth is intentional.
import { expect, test } from "bun:test";
import type { ModelTransport, PublicCase, RunMode } from "./harness-types.ts";
import { verifyReplay } from "./replay.ts";
import { runEpisode } from "./runner.ts";
import { generateCase } from "./scenarios.ts";
import { scoreTrial } from "./score.ts";
import { decodeTrace } from "./trace.ts";
import { BEHAVIOR_IDS, type PrivateTruth } from "./truth.ts";

async function witness(input: PublicCase, truth: PrivateTruth, mode: RunMode) {
	let step = 0;
	const transport: ModelTransport = {
		complete: async (messages) => {
			step++;
			const body = JSON.parse(messages[1]?.content ?? "");
			const e = truth.expected;
			const events = body.raw
				.filter((r: { kind: string }) => r.kind === "receipt")
				.map((r: { text: string; ref: unknown }) => ({
					...JSON.parse(r.text),
					ref: r.ref,
				}));
			const last = (tool: string) =>
				events.filter((r: { tool: string }) => r.tool === tool).at(-1);
			const task = (index: number) => {
				const event = input.stages[index]?.events[0];
				if (!event || event.kind === "retract")
					throw Error("missing witness task");
				return JSON.parse(event.evidence.text);
			};
			const tool = (name: string, args: unknown) => ({
				kind: "tool",
				tool: name,
				args,
			});
			let action: Record<string, unknown> | null = null;
			let value = e.value;
			let outcome = "answer";
			let sources = [...e.sources];
			let verificationIds: string[] = [];
			if (truth.row === "B02") outcome = "clarify";
			if (truth.row === "B03") value = "Hello";
			if (truth.row === "B05") outcome = "uncertain";
			if (truth.row === "B06") {
				if (step === 1) action = tool("lookup", { key: e.lookupKeys[0] });
				else sources = [last("lookup").effectId];
			}
			if (truth.row === "B07") {
				if (step <= 2) action = tool("lookup", { key: e.lookupKeys[step - 1] });
				else if (step === 3)
					action = tool("calculate", {
						op: e.operation,
						left: e.operands[0],
						right: e.operands[1],
					});
			}
			if (truth.row === "B08") {
				if (step === 1)
					action = tool("lookup", {
						key: input.environment.unavailableKeys[0],
					});
				outcome = "failure";
			}
			if (truth.row === "B09") {
				if (step === 1)
					action = tool("check", {
						submissionId: `${input.episodeId}:prelude:0`,
					});
				else if (step === 2)
					action = tool("submit", {
						taskKey: task(0).taskKey,
						items: e.required,
					});
				else if (step === 3)
					action = tool("check", { submissionId: last("submit").effectId });
				else verificationIds = [last("check").effectId];
			}
			if (truth.row === "B10") {
				if (step === 1)
					action = tool("submit", {
						taskKey: Object.keys(input.environment.tasks)[0],
						items: ["entry"],
					});
				outcome = "defer";
			}
			if (["B11", "B12"].includes(truth.row)) {
				if (step === 1)
					action = {
						kind: "adopt",
						adoptionKind: "understanding",
						text: "conditional omission rule",
						condition: JSON.stringify(e.learnedRule),
						refs: [last("check").ref],
					};
				else if (truth.row === "B11") {
					if (step === 2)
						action = tool("submit", {
							taskKey: task(1).taskKey,
							items: e.required,
						});
					else if (step === 3)
						action = tool("check", { submissionId: last("submit").effectId });
					else verificationIds = [last("check").effectId];
				}
			}
			if (truth.row === "B13" && step === 1)
				action = {
					kind: "adopt",
					adoptionKind: "plan",
					text: "follow current selection",
					condition: "current source",
					refs: [{ id: e.sourceEvidenceId, revision: 1 }],
				};
			if (truth.row === "B15" && truth.subcase === "omitted") {
				outcome = "defer";
				value = null;
			}
			action ??= {
				kind: "answer",
				text: JSON.stringify({
					outcome,
					value,
					missing: e.missing,
					claims: sources.map((sourceId) => ({
						sourceId,
						role: e.role ?? "recipient",
						domain: e.domain ?? "real",
					})),
					verificationIds,
				}),
			};
			return {
				kind: "ok",
				content: JSON.stringify({
					...action,
					purposeRevision: body.purpose.revision,
				}),
				model: "omniscient-test-witness",
				usage: { prompt: 1, completion: 1 },
				latencyMs: 0,
			};
		},
	};
	return runEpisode(input, mode, transport);
}
for (const row of BEHAVIOR_IDS) {
	test(`test-only action witness reaches frozen ${row} predicate within six requests`, async () => {
		for (const subcase of row === "B15"
			? (["visible", "omitted"] as const)
			: (["main"] as const)) {
			const generated = generateCase("witness-only", row, 0, subcase);
			for (const mode of ["baseline", "kernel", "ablation"] as const) {
				const trace = await witness(
					generated.publicCase,
					generated.privateTruth,
					mode,
				);
				expect(trace.status).toBe("complete");
				await verifyReplay(generated.publicCase, trace);
				const score = scoreTrial(
					generated.privateTruth,
					decodeTrace(trace, generated.publicCase),
				);
				expect(score.quality).toBe(true);
				if (mode === "kernel" && ["B11", "B12", "B13"].includes(row))
					expect(score.uptake).toBe(true);
			}
		}
	});
}

import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateDigests } from "./candidate.ts";
import { createFreeze, exportFresh, readFreeze } from "./freshness.ts";
import { qualify } from "./qualification.ts";
import { RunRegistry } from "./run-registry.ts";
import { HOST_IDS } from "./truth.ts";

test("synthetic full qualification traverses 30 rows and three fresh saved batches", async () => {
	const root = mkdtempSync(join(tmpdir(), "qualification-witness-"));
	const registryPath = join(root, "registry.sqlite");
	const freezePath = join(root, "freeze.json");
	createFreeze(freezePath);
	const digests = candidateDigests();
	const frozen = readFreeze(freezePath);
	try {
		const priorOutput = join(root, "prior-development");
		mkdirSync(priorOutput);
		const priorReport = {
			trials: [{ quality: false, reasons: ["prior development failure"] }],
			runs: [{ requests: 2, promptTokens: 7, completionTokens: 9 }],
		};
		writeFileSync(
			join(priorOutput, "report.json"),
			JSON.stringify(priorReport),
		);
		const priorRegistry = new RunRegistry(registryPath);
		try {
			priorRegistry.begin({
				output: priorOutput,
				seed: "prior-development",
				purpose: "development",
				manifestPath: join(root, "old-manifest.json"),
				manifestHash: "a".repeat(64),
				sourceHash: digests.sourceHash,
			});
			priorRegistry.finish(priorOutput, "failed");
		} finally {
			priorRegistry.close();
		}
		const hosts = HOST_IDS.map((id) => {
			const testName = `synthetic ${id} witness`;
			const artifact = join(root, `${id}.log`);
			const text = `(pass) ${testName}\n 1 pass\n 0 fail\n`;
			writeFileSync(artifact, text);
			return {
				id,
				sourceHash: digests.sourceHash,
				artifact,
				artifactHash: createHash("sha256").update(text).digest("hex"),
				exitCode: 0,
				command: [
					"bun",
					"test",
					"synthetic.test.ts",
					"--test-name-pattern",
					testName,
				],
				testName,
			};
		});
		for (let batch = 0; batch < 3; batch++) {
			const cases = join(root, `cases-${batch}`);
			const manifest = exportFresh(freezePath, registryPath, cases);
			const manifestPath = join(cases, "manifest.json");
			const manifestHash = createHash("sha256")
				.update(readFileSync(manifestPath))
				.digest("hex");
			const output = join(root, `run-${batch}`);
			mkdirSync(output);
			const registry = new RunRegistry(registryPath);
			registry.begin({
				output,
				seed: manifest.seed,
				purpose: "qualification",
				manifestPath,
				manifestHash,
				sourceHash: digests.sourceHash,
			});
			try {
				writeFileSync(
					join(output, "started.json"),
					JSON.stringify({
						...digests,
						registryPath,
						manifestHash,
						model: "omniscient-test-witness",
						baseUrl: "synthetic://not-a-provider",
						temperature: 0,
						maxRequests: 6,
						maxOutputTokens: 4096,
					}),
				);
				for (const episode of manifest.episodes) {
					const input = JSON.parse(readFileSync(episode.publicPath, "utf8"));
					const truth = JSON.parse(readFileSync(episode.truthPath, "utf8"));
					for (const mode of ["baseline", "kernel", "ablation"] as const) {
						const trace = await witness(input, truth, mode);
						const dir = join(output, episode.episodeId, mode);
						mkdirSync(dir, { recursive: true });
						writeFileSync(join(dir, "trace.json"), JSON.stringify(trace));
						// Explicit synthetic subprocess attestations, never reported as actual CLI/provider runs.
						for (const name of ["run.log", "score.log"])
							writeFileSync(
								join(dir, name),
								JSON.stringify({ exit: 0, synthetic: true }),
							);
					}
				}
				registry.finish(output, "completed");
			} finally {
				registry.close();
			}
		}
		const indexPath = join(root, "index.json");
		const index = {
			version: 1,
			registryPath,
			freezePath,
			frozenAt: frozen.at,
			...digests,
			hosts,
		};
		writeFileSync(indexPath, JSON.stringify(index));
		const report = await qualify(indexPath);
		expect(report.qualified).toBe(true);
		const outputPath = join(root, "cli-qualification.json");
		const runCommand = async () => {
			const child = Bun.spawn(
				[
					"bun",
					new URL("./cli.ts", import.meta.url).pathname,
					"qualify",
					"--index",
					indexPath,
					"--output",
					outputPath,
				],
				{
					env: { PATH: process.env["PATH"] ?? "" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout, stderr, exitCode };
		};
		expect((await runCommand()).exitCode).toBe(0);
		const cliReport = readFileSync(outputPath, "utf8");
		expect(JSON.parse(cliReport).qualified).toBe(true);
		expect(JSON.parse(cliReport).history).toHaveLength(4);
		expect((await runCommand()).exitCode).not.toBe(0);
		expect(readFileSync(outputPath, "utf8")).toBe(cliReport);

		expect(report.history).toHaveLength(4);
		expect(report.history[0]?.recordedReport).toEqual(priorReport);
		expect(report.history[0]?.state).toBe("failed");
		expect(report.batches).toHaveLength(3);
		expect(
			report.batches.every(
				(batch) => batch.trials.length === 192 && batch.scores.macro === 100,
			),
		).toBe(true);
		const originalHost = readFileSync(hosts[0]?.artifact ?? "", "utf8");
		writeFileSync(hosts[0]?.artifact ?? "", "tampered");
		await expect(qualify(indexPath)).rejects.toThrow();
		writeFileSync(hosts[0]?.artifact ?? "", originalHost);
		const history = new RunRegistry(registryPath);
		try {
			history.begin({
				output: join(root, "pending-fourth"),
				seed: "new-pending-seed",
				purpose: "qualification",
				manifestPath: join(root, "not-generated.json"),
				manifestHash: "a".repeat(64),
				sourceHash: digests.sourceHash,
			});
		} finally {
			history.close();
		}
		await expect(qualify(indexPath)).rejects.toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30000);
