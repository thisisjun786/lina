import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	authorHash,
	authorRecord,
} from "../../packages/lina-codex/src/author-native-policy.ts";
import { MOIRAI_ROLES } from "../../packages/lina-codex/src/moirai-probe.ts";
import {
	readProbeRecord,
	writeProbeRecord,
} from "../../packages/lina-codex/src/moirai-probe-state.ts";
import {
	PROBE_REQUEST_OPTIONS,
	probeWireItems,
	verifyProbeWire,
} from "../../packages/lina-codex/src/moirai-probe-transport.ts";
import { probeEvidenceRoot } from "./moirai-native-lifecycle.ts";
import {
	PROMPT_CASES,
	type PromptCondition,
	promptExperiment,
} from "./moirai-prompt-cases.ts";

type Options = {
	root: string;
	caseIds?: readonly string[];
	signal?: AbortSignal;
	commandFor?: (
		condition: PromptCondition,
		caseId: string,
		root: string,
	) => readonly string[];
};
type Observation = {
	key: string;
	settings: Record<string, unknown>;
	input: unknown;
	nativeContext: unknown;
	instructions: unknown;
	rawResponse: unknown;
	usage: unknown;
	latencyMs: number | null;
	judgment: unknown;
	aggregationEligible: boolean;
	validationError: string | null;
	nativeIdentity: { threadId: unknown; turnId: unknown };
};
type ConditionResult = {
	condition: PromptCondition;
	caseId: string;
	root: string;
	exitCode: number;
	stderr: string;
	status: "pass" | "failed";
	errors: string[];
	attempts: number;
	observations: Observation[];
	runtime: Record<string, unknown> | null;
};

const requiredSettings = {
	...PROBE_REQUEST_OPTIONS,
	max_output_tokens: 4096,
	tools: [],
	tool_choice: "none",
	stream: true,
};

function inspectCondition(
	root: string,
	condition: PromptCondition,
	caseId: string,
) {
	const errors: string[] = [];
	const object = (value: unknown, name: string) => {
		try {
			return authorRecord(value);
		} catch {
			errors.push(`Malformed ${name}`);
			return {};
		}
	};
	const read = (path: string, required = true) => {
		try {
			return readProbeRecord(join(root, path));
		} catch {
			if (required) errors.push(`Missing or malformed ${path}`);
			return null;
		}
	};
	const result = read("result.json", false);
	if (!result) errors.push("Missing child result.json");
	if (
		result?.["status"] !== "pass" ||
		result?.["live"] !== false ||
		result?.["ownedProcessesClosed"] !== true
	)
		errors.push("Child did not verify completion and teardown");
	const runtime = read("runtime.json");
	const spec = promptExperiment(condition, caseId);
	const manifest = object(runtime?.["experiment"], "experiment manifest");
	if (
		manifest["condition"] !== condition ||
		manifest["caseId"] !== caseId ||
		manifest["input"] !== spec.input ||
		manifest["inputDigest"] !== spec.inputDigest ||
		!isDeepStrictEqual(manifest["pack"], spec.pack)
	)
		errors.push("Experiment manifest mismatch");
	const observations: Observation[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(join(root, "wire"))
			.filter((n) => n.endsWith("-outbound.json"))
			.sort();
	} catch {
		errors.push("Missing outbound records");
	}
	const attempts = new Set<number>();
	for (const name of names) {
		const key = name.slice(0, -"-outbound.json".length);
		const outbound = read(`wire/${name}`);
		const body = object(outbound?.["body"], `${key} outbound body`);
		const role = MOIRAI_ROLES.find((r) => key.endsWith(`-${r}`));
		if (!role || body["instructions"] !== spec.pack.instructions[role])
			errors.push(`${key}: actual prompt mismatch`);
		let roundId: string | null = null;
		let nativeContext: unknown = null;
		try {
			const items = body["input"];
			if (!Array.isArray(items) || !items.length)
				throw Error("expected fresh input");
			const item = authorRecord(items.at(-1));
			const parts = item["content"];
			if (
				item["role"] !== "user" ||
				!Array.isArray(parts) ||
				parts.length !== 1
			)
				throw Error("expected one user text");
			const sent = authorRecord(parts[0])["text"];
			if (typeof sent !== "string" || !role)
				throw Error("expected text and known role");
			verifyProbeWire(items, sent, null);
			nativeContext = probeWireItems(items).slice(0, -1);
			const envelope = authorRecord(JSON.parse(sent));
			const round = envelope["roundId"];
			if (typeof round !== "string") throw Error("missing round ID");
			roundId = round;
			const payload =
				role === "moirai"
					? authorRecord(envelope["input"])["input"]
					: envelope["input"];
			if (!isDeepStrictEqual(payload, JSON.parse(spec.input)))
				throw Error("fixed input changed");
			const expected = spec.protocol.envelope(
				round,
				role,
				JSON.stringify(envelope["input"]),
			);
			if (sent !== expected) throw Error("non-neutral envelope");
		} catch (error) {
			errors.push(`${key}: actual input mismatch: ${String(error)}`);
		}
		const settings = Object.fromEntries(
			["model", ...Object.keys(requiredSettings)].map((k) => [k, body[k]]),
		);
		for (const [k, v] of Object.entries(requiredSettings))
			if (!isDeepStrictEqual(body[k], v))
				errors.push(`${key}: wire setting ${k}`);
		if (
			typeof body["model"] !== "string" ||
			body["model"] !== result?.["model"]
		)
			errors.push(`${key}: model mismatch`);
		const attempt = outbound?.["attempt"];
		if (
			typeof attempt !== "number" ||
			!Number.isInteger(attempt) ||
			attempt < 1 ||
			attempt > 4 ||
			attempts.has(attempt)
		)
			errors.push(`${key}: attempt limit or duplicate`);
		else attempts.add(attempt);
		const settled = read(`wire/${key}-settled.json`, false);
		const response = read(`wire/${key}-response.json`, false);
		const failure = read(`wire/${key}-failure.json`, false);
		const native =
			roundId && role
				? read(`ledger/round-${roundId}/result-${role}.json`, false)
				: null;
		let judgment: unknown = null;
		let validationError: string | null = null;
		try {
			if (!roundId || !role || typeof native?.["text"] !== "string")
				throw Error("Missing native judgment");
			judgment = spec.protocol.validateOutput(roundId, role, native["text"]);
			if (authorRecord(judgment)["status"] === "invalidated")
				errors.push(`${key}: judgment invalidated; aggregation forbidden`);
		} catch (error) {
			validationError = String(error);
			errors.push(`${key}: ${validationError}`);
		}
		const start = outbound?.["startedAt"],
			end = settled?.["endedAt"] ?? response?.["endedAt"];
		if (!settled || typeof response?.["raw"] !== "string" || !response["raw"])
			errors.push(`${key}: missing settled or raw response evidence`);
		observations.push({
			nativeContext,
			judgment,
			aggregationEligible:
				judgment !== null && authorRecord(judgment)["status"] !== "invalidated",
			validationError,
			nativeIdentity: {
				threadId: native?.["threadId"] ?? null,
				turnId: native?.["turnId"] ?? null,
			},
			key,
			settings,
			input: body["input"],
			instructions: body["instructions"],
			rawResponse: response?.["raw"] ?? failure?.["partial"] ?? null,
			usage: settled?.["usage"] ?? null,
			latencyMs:
				typeof start === "number" && typeof end === "number" && end >= start
					? end - start
					: null,
		});
	}
	if (names.length !== 4 || attempts.size !== 4)
		errors.push("Four generation attempts did not complete");
	if (!isDeepStrictEqual(runtime?.["requestOptions"], requiredSettings))
		errors.push("Intended request options mismatch");
	return { errors, observations, runtime, attempts: names.length };
}

/** Runs real child processes. The override is internal test injection, never a CLI flag. */
export async function runComparison(options: Options) {
	const caseIds = options.caseIds ?? PROMPT_CASES.map((c) => c.id);
	if (
		!caseIds.length ||
		new Set(caseIds).size !== caseIds.length ||
		caseIds.some((id) => !PROMPT_CASES.some((c) => c.id === id))
	)
		throw Error("Invalid comparison cases");
	const root = probeEvidenceRoot(
		options.root,
		resolve(import.meta.dir, "../.."),
	);
	mkdirSync(root, { mode: 0o700 });
	const conditions: ConditionResult[] = [];
	for (const caseId of caseIds) {
		for (const condition of ["C", "E"] as const) {
			const childRoot = join(root, `${caseId}-${condition}`);
			const signal = AbortSignal.any([
				...(options.signal ? [options.signal] : []),
				AbortSignal.timeout(300000),
			]);
			// Native owns creation of its new root. Injected fixture commands get their own root.
			if (options.commandFor) mkdirSync(childRoot, { mode: 0o700 });
			let exitCode = -1,
				stderr = "";
			try {
				signal.throwIfAborted();
				const command = options.commandFor?.(condition, caseId, childRoot) ?? [
					process.execPath,
					join(import.meta.dir, "moirai-native.ts"),
					`--root=${childRoot}`,
					`--prompt-condition=${condition}`,
					`--case=${caseId}`,
				];
				const child = Bun.spawn([...command], {
					cwd: resolve(import.meta.dir, "../.."),
					stdout: "pipe",
					stderr: "pipe",
				});
				let forceStop: ReturnType<typeof setTimeout> | undefined;
				const stop = () => {
					child.kill("SIGTERM");
					forceStop = setTimeout(() => child.kill("SIGKILL"), 15000);
				};
				signal.addEventListener("abort", stop, { once: true });
				if (signal.aborted) stop();
				let output: [number, string, string];
				try {
					output = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
				} finally {
					signal.removeEventListener("abort", stop);
					clearTimeout(forceStop);
				}
				exitCode = output[0];
				stderr = output[2];
				writeFileSync(
					join(root, `${caseId}-${condition}-stdout.log`),
					output[1],
					{ mode: 0o600, flag: "wx" },
				);
			} catch (error) {
				stderr = String(error);
			}
			const inspected = inspectCondition(childRoot, condition, caseId);
			if (signal.aborted)
				inspected.errors.push(`Comparison cancelled: ${String(signal.reason)}`);
			if (exitCode !== 0) inspected.errors.push(`Child exit ${exitCode}`);
			conditions.push({
				condition,
				caseId,
				root: childRoot,
				exitCode,
				stderr,
				status: inspected.errors.length ? "failed" : "pass",
				...inspected,
			});
		}
		const pair = conditions.slice(-2);
		const identity = (row: ConditionResult) => ({
			implementation: row.runtime?.["implementation"],
			command: row.runtime?.["command"],
			wrapper: row.runtime?.["wrapper"],
			bun: row.runtime?.["bun"],
			platform: row.runtime?.["platform"],
			arch: row.runtime?.["arch"],
			settings: row.observations.map((o) => o.settings),
			nativeContext: row.observations.map((o) => o.nativeContext),
		});
		if (
			!pair[0] ||
			!pair[1] ||
			!isDeepStrictEqual(identity(pair[0]), identity(pair[1]))
		) {
			for (const row of pair) {
				row.status = "failed";
				row.errors.push("Paired runtime or actual wire settings differ");
			}
		}
	}
	const result = {
		version: 1,
		scope:
			"synthetic execution contract only; no model quality or measured token-cost claim",
		expectedConditions: caseIds.length * 2,
		passedConditions: conditions.filter((c) => c.status === "pass").length,
		failedConditions: conditions.filter((c) => c.status === "failed").length,
		conditions,
	};
	writeProbeRecord(join(root, "comparison.json"), result);
	return result;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log(
			"Usage: bun scripts/qa/moirai-prompt-compare.ts --root=/absolute/new/path (synthetic only)",
		);
		process.exit(0);
	}
	if (args.length === 1 && args[0] === "--version") {
		console.log("moirai-prompt-compare 1");
		process.exit(0);
	}
	if (args.length !== 1 || !args[0]?.startsWith("--root="))
		throw Error(
			`Invalid arguments ${args.join(" ")}. Usage: bun scripts/qa/moirai-prompt-compare.ts --root=/absolute/new/path (synthetic only)`,
		);
	const abort = new AbortController();
	const stop = () => abort.abort(Error("Comparison interrupted"));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	let result: Awaited<ReturnType<typeof runComparison>>;
	try {
		result = await runComparison({
			root: args[0].slice(7),
			signal: abort.signal,
		});
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
	console.log(
		JSON.stringify({
			expected: result.expectedConditions,
			passed: result.passedConditions,
			failed: result.failedConditions,
			artifact: join(args[0].slice(7), "comparison.json"),
			digest: authorHash(JSON.stringify(result)),
		}),
	);
	if (result.failedConditions) process.exitCode = 1;
}
