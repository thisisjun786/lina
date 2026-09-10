import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	PROMPT_CASES,
	promptExperiment,
	promptSelection,
	syntheticJudgment,
} from "../../../scripts/qa/moirai-prompt-cases.ts";
import { runComparison } from "../../../scripts/qa/moirai-prompt-compare.ts";
import { fixture } from "./moirai-probe-fixture.ts";

test("cancellation signals the owned child, waits for cleanup and retains unstarted conditions", async () => {
	const temp = mkdtempSync(join(tmpdir(), "moirai-compare-abort-"));
	const ready = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			ready.resolve();
			return new Response("ready");
		},
	});
	const abort = new AbortController();
	let launched = 0;
	try {
		const result = runComparison({
			root: join(temp, "run"),
			caseIds: ["simple"],
			signal: abort.signal,
			commandFor: (_condition, _caseId, root) => {
				launched++;
				return [
					process.execPath,
					"-e",
					`import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>{writeFileSync(process.argv[1]+'/closed','closed');process.exit(0)});setTimeout(()=>process.exit(3),1500);await fetch(process.argv[2]);`,
					root,
					server.url.href,
				];
			},
		});
		await ready.promise;
		abort.abort(Error("synthetic cancellation"));
		const observed = await result;
		expect(launched).toBe(1);
		expect(readFileSync(join(temp, "run/simple-C/closed"), "utf8")).toBe(
			"closed",
		);
		expect(observed.failedConditions).toBe(2);
		expect(
			observed.conditions[0]?.errors.some((e) => e.includes("cancelled")),
		).toBe(true);
		expect(observed.conditions[1]?.attempts).toBe(0);
	} finally {
		await server.stop(true);
		rmSync(temp, { recursive: true, force: true });
	}
});

test("comparison admits native context, preserves unknown usage, and rejects changed evidence", async () => {
	const temp = mkdtempSync(join(tmpdir(), "moirai-compare-records-"));
	try {
		for (const mutation of [
			"none",
			"history",
			"preamble",
			"invalidated",
			"missing-response",
			"manifest-input",
		]) {
			const result = await runComparison({
				root: join(temp, mutation),
				caseIds: ["simple"],
				commandFor: (condition, caseId, root) => {
					const save = (path: string, value: unknown) => {
						mkdirSync(dirname(join(root, path)), { recursive: true });
						writeFileSync(join(root, path), JSON.stringify(value));
					};
					const spec = promptExperiment(condition, caseId);
					const options = {
						reasoning: { effort: "none" },
						store: false,
						parallel_tool_calls: false,
						include: ["reasoning.encrypted_content"],
						max_output_tokens: 4096,
						tools: [],
						tool_choice: "none",
						stream: true,
					};
					save("result.json", {
						status: "pass",
						live: false,
						ownedProcessesClosed: true,
						model: "fixture",
					});
					save("runtime.json", {
						experiment: {
							...spec,
							input:
								condition === "C" && mutation === "manifest-input"
									? "changed"
									: spec.input,
							protocol: undefined,
						},
						requestOptions: options,
						implementation: "synthetic-source",
						command: "synthetic-native",
						wrapper: "synthetic-wrapper",
						bun: "fixture",
						platform: "linux",
						arch: "x64",
					});
					const proposals: unknown[] = [];
					for (const [i, role] of (
						["clotho", "lachesis", "atropos", "moirai"] as const
					).entries()) {
						const key = `fixture-round-${role}`;
						const payload =
							role === "moirai"
								? JSON.stringify({ input: JSON.parse(spec.input), proposals })
								: spec.input;
						const text = spec.protocol.envelope("fixture-round", role, payload);
						const message = (role: string, text: string) => ({
							type: "message",
							role,
							content: [{ type: "input_text", text }],
						});
						const input = [
							message(
								"developer",
								"<permissions instructions>\nread-only\n</permissions instructions>",
							),
							message(
								"user",
								"<environment_context>\nsynthetic\n</environment_context>",
							),
							message("user", text),
						];
						if (condition === "C" && i === 0) {
							if (mutation === "history")
								input.unshift(message("user", "old conversation"));
							if (mutation === "preamble")
								input[0] = message(
									"developer",
									"<permissions instructions>\nchanged\n</permissions instructions>",
								);
						}
						const judgment = JSON.parse(syntheticJudgment({ input }));
						if (condition === "C" && i === 0 && mutation === "invalidated")
							Object.assign(judgment, {
								status: "invalidated",
								candidate: null,
							});
						const output = JSON.stringify(judgment);
						proposals.push({
							output: judgment,
							completion: "native-and-provider-verified",
						});
						save(`wire/${key}-outbound.json`, {
							body: {
								...options,
								model: "fixture",
								instructions: spec.pack.instructions[role],
								input,
							},
							attempt: i + 1,
							startedAt: 10,
						});
						save(`wire/${key}-settled.json`, {
							endedAt: 20,
							text: output,
							input,
							output: [],
							usage: null,
						});
						if (
							!(condition === "C" && i === 0 && mutation === "missing-response")
						)
							save(`wire/${key}-response.json`, {
								endedAt: 20,
								raw: "synthetic wire fixture",
							});
						save(`ledger/round-fixture-round/result-${role}.json`, {
							text: output,
							threadId: `${condition}-thread-${i}`,
							turnId: `${condition}-turn-${i}`,
						});
					}
					return [process.execPath, "-e", "process.exit(0)"];
				},
			});
			expect(result.expectedConditions).toBe(2);
			if (mutation === "none") {
				expect(result.failedConditions).toBe(0);
				expect(result.conditions[0]?.observations[0]?.usage).toBeNull();
				expect(result.conditions[0]?.observations[0]?.latencyMs).toBe(10);
			} else {
				expect(result.conditions[0]?.status).toBe("failed");
				if (mutation === "invalidated") {
					const observation = result.conditions[0]?.observations.find((o) =>
						o.key.endsWith("clotho"),
					);
					expect(observation?.validationError).toBeNull();
					expect(observation?.judgment).toMatchObject({
						status: "invalidated",
					});
					expect(observation?.aggregationEligible).toBe(false);
				}
			}
		}
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

test("comparison CLI help and malformed invocation never start native", async () => {
	const entry = join(
		import.meta.dir,
		"../../../scripts/qa/moirai-prompt-compare.ts",
	);
	for (const args of [
		["--help"],
		["--version"],
		[],
		["--unknown"],
		["--root=relative"],
	]) {
		const child = Bun.spawn([process.execPath, entry, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		if (args[0] === "--help" || args[0] === "--version") {
			expect(code).toBe(0);
			expect(stdout.length).toBeGreaterThan(0);
			expect(stderr).toBe("");
		} else {
			expect(code).not.toBe(0);
			expect(stderr.length).toBeGreaterThan(0);
		}
	}
});

test("prompt options reject incomplete, unknown and live selections before starting native", () => {
	expect(promptSelection([])).toBeNull();
	for (const args of [
		["--case=simple"],
		["--prompt-condition=X", "--case=simple"],
		["--prompt-condition=C"],
		["--prompt-condition=C", "--case=missing"],
		["--prompt-condition=E", "--case=simple", "--live"],
		["--prompt-condition"],
		["--case"],
		["--prompt-condition=C=extra", "--case=simple"],
		["--prompt-condition=C", "--case=simple", "--case=correction"],
	]) {
		expect(() => promptSelection(args)).toThrow();
	}
	expect(
		promptSelection(["--prompt-condition=C", "--case=simple"])?.condition,
	).toBe("C");
});

for (const mutation of [
	"json",
	"proposal-id",
	"round-id",
	"snapshot-id",
	"stale-source",
	"unknown-source",
	"invalidated",
	"synthesis-duplicate",
	"need-evidence",
]) {
	test(`actual prompt protocol drives probe validation and preserves failures: ${mutation}`, async () => {
		const spec = promptExperiment("E", "conflict");
		const f = fixture(undefined, spec.protocol, (index, input) => {
			const text = syntheticJudgment({
				input: [
					{ role: "user", content: [{ type: "input_text", text: input }] },
				],
			});
			const output = JSON.parse(text);
			if (mutation === "synthesis-duplicate" && index === 3)
				output.consideredProposals[1].proposalId =
					output.consideredProposals[0].proposalId;
			if (index !== 0) return JSON.stringify(output);
			if (mutation === "json") return "invalid JSON";
			if (mutation === "proposal-id") output.proposalId = "wrong";
			if (mutation === "round-id") output.roundId = "wrong";
			if (mutation === "snapshot-id") output.snapshotId = "wrong";
			if (mutation.endsWith("source"))
				output.support = [
					{
						claim: "합성 주장",
						sourceRefs: [
							mutation === "stale-source" ? "schedule-old" : "unknown-source",
						],
					},
				];
			if (mutation === "invalidated") {
				output.status = "invalidated";
				output.candidate = null;
			}
			if (mutation === "need-evidence") {
				output.status = "need_evidence";
				output.candidate.kind = "ask_user";
				output.evidenceRequest = "현재 자료를 확인해야 한다.";
			}
			return JSON.stringify(output);
		});
		await f.probe.initialize();
		const run = f.probe.round(
			"round-one",
			spec.input,
			new AbortController().signal,
		);
		void run.catch(() => {});
		void f.started(3).then(() => f.complete(3));
		await f.entered.promise;
		for (let i = 0; i < 3; i++) f.complete(i);
		if (mutation === "need-evidence") {
			const results = await run;
			expect(results).toHaveLength(4);
			expect(JSON.parse(results[0]?.text ?? "").status).toBe("need_evidence");
			expect(f.pending).toHaveLength(4);
		} else {
			await expect(run).rejects.toThrow();
			expect(f.aggregates).toBe(mutation === "synthesis-duplicate" ? 1 : 0);
			expect(existsSync(join(f.root, "round-round-one/complete.json"))).toBe(
				false,
			);
			expect(existsSync(join(f.root, "round-round-one/failure.json"))).toBe(
				true,
			);
			if (mutation === "invalidated") {
				expect(
					existsSync(join(f.root, "round-round-one/failure-clotho.json")),
				).toBe(false);
				expect(
					JSON.parse(
						readFileSync(
							join(f.root, "round-round-one/judgment-clotho.json"),
							"utf8",
						),
					).status,
				).toBe("invalidated");
			}
		}
	});
}

test("fixed cases use the same neutral inputs across conditions and validate synthetic outputs", () => {
	for (const specimen of PROMPT_CASES) {
		const c = promptExperiment("C", specimen.id);
		const e = promptExperiment("E", specimen.id);
		expect(c.input).toBe(e.input);
		expect(JSON.parse(c.input).promptRevision).toBe(c.pack.revision);
		for (const role of ["clotho", "lachesis", "atropos"] as const) {
			const input = c.protocol.envelope("one", role, c.input);
			expect(input).toBe(e.protocol.envelope("one", role, e.input));
			expect(input).not.toMatch(/clotho|lachesis|atropos/);
			const output = syntheticJudgment({
				input: [
					{ role: "user", content: [{ type: "input_text", text: input }] },
				],
			});
			expect(() =>
				c.protocol.validateOutput("one", role, output),
			).not.toThrow();
			const wrong = JSON.parse(output);
			wrong.snapshotId = "other";
			expect(() =>
				c.protocol.validateOutput("one", role, JSON.stringify(wrong)),
			).toThrow();
		}
	}
});

test("real child failure without result keeps stderr, exit code and denominator and still runs E", async () => {
	const temp = mkdtempSync(join(tmpdir(), "moirai-compare-child-"));
	try {
		const child = join(temp, "child.ts");
		writeFileSync(
			child,
			`import {writeFileSync} from 'node:fs';import {join} from 'node:path';const [arm,root]=process.argv.slice(2);if(arm==='C'){console.error('synthetic child failure');process.exit(7);}writeFileSync(join(root,'visited'),'E');writeFileSync(join(root,'result.json'),JSON.stringify({status:'pass',synthetic:true}));`,
		);
		const result = await runComparison({
			root: join(temp, "run"),
			caseIds: ["simple"],
			commandFor: (condition, _case, root) => [
				process.execPath,
				child,
				condition,
				root,
			],
		});
		expect(result.conditions).toHaveLength(2);
		expect(result.conditions[0]?.exitCode).toBe(7);
		expect(result.conditions[0]?.stderr).toContain("synthetic child failure");
		expect(result.conditions[0]?.errors).toContain("Missing child result.json");
		expect(result.conditions[0]?.status).toBe("failed");
		expect(existsSync(join(temp, "run/simple-E/visited"))).toBe(true);
		expect(result.expectedConditions).toBe(2);
		expect(
			JSON.parse(readFileSync(join(temp, "run/comparison.json"), "utf8"))
				.conditions,
		).toHaveLength(2);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
