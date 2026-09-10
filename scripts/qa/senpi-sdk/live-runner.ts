import { randomInt, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentSession, defineTool } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import { z } from "zod";
import { type LiveCapture, startLiveCapture } from "./live-capture.ts";
import {
	evaluateLiveEvidence,
	type LiveEvidence,
	type LiveToolCall,
	type LiveTruth,
} from "./live-evidence.ts";
import { assistantText, createLiveSession } from "./live-session.ts";
import manifest from "./package.json" with { type: "json" };

export type LiveRunOptions = {
	readonly upstreamBaseUrl: string;
	readonly credential?: string;
	readonly evidenceDir: string;
};

type LiveCleanup = {
	sessionClosed: boolean;
	captureClosed: boolean;
	scratchRemoved: boolean;
	scratch: string;
	port: number | null;
};

export type LiveRunReport = {
	readonly verdict: "pass" | "fail";
	readonly sdk: string;
	readonly version: string;
	readonly api: string;
	readonly requestedModel: string;
	readonly truth: LiveTruth;
	readonly evidence: LiveEvidence;
	readonly evaluation: ReturnType<typeof evaluateLiveEvidence>;
	readonly errors: readonly string[];
	readonly planningText: string;
	readonly elapsedMs: number;
	readonly runtime: { bun: string; platform: string; arch: string };
	readonly monetaryCost: null;
	readonly cleanup: {
		readonly sessionClosed: boolean;
		readonly captureClosed: boolean;
		readonly scratchRemoved: boolean;
		readonly scratch: string;
		readonly port: number | null;
	};
};

export async function runLiveScenario(
	options: LiveRunOptions,
): Promise<LiveRunReport> {
	const sdk = z
		.object({
			name: z.literal("@code-yeongyu/senpi"),
			version: z.literal(manifest.dependencies["@code-yeongyu/senpi"]),
		})
		.parse(
			JSON.parse(
				readFileSync(
					new URL(
						"../package.json",
						import.meta.resolve("@code-yeongyu/senpi"),
					),
					"utf8",
				),
			),
		);
	await mkdir(options.evidenceDir, { mode: 0o700 });
	const serialize = (value: unknown) => {
		const text = JSON.stringify(value);
		return options.credential
			? text.replaceAll(options.credential, "[REDACTED]")
			: text;
	};
	const save = (name: string, value: unknown) =>
		writeFileSync(join(options.evidenceDir, name), `${serialize(value)}\n`, {
			mode: 0o600,
		});
	const truth: LiveTruth = {
		warehouse: "west",
		sku: "BOLT",
		quantity: randomInt(10, 100),
		receipt: `inventory-${randomUUID()}`,
	};
	save("environment.json", { west: truth, eastQuantity: truth.quantity + 100 });
	const calls: LiveToolCall[] = [];
	const errors: string[] = [];
	let initialToolCalls = 0;
	let attempts = 0;
	let planningText = "";
	let finalText = "";
	let scratch = "";
	let capture: LiveCapture | undefined;
	let session: AgentSession | undefined;
	const cleanup: LiveCleanup = {
		sessionClosed: true,
		captureClosed: true,
		scratchRemoved: true,
		scratch: "",
		port: null,
	};
	const started = performance.now();
	try {
		scratch = await mkdtemp(join(tmpdir(), "senpi-live-runtime-"));
		cleanup.scratch = scratch;
		cleanup.scratchRemoved = false;
		for (const name of ["workspace", "agent", "sessions"])
			await mkdir(join(scratch, name));
		await mkdir(join(options.evidenceDir, "wire"));
		capture = startLiveCapture({
			upstreamBaseUrl: options.upstreamBaseUrl,
			evidenceDir: join(options.evidenceDir, "wire"),
			...(options.credential ? { credential: options.credential } : {}),
		});
		cleanup.captureClosed = false;
		const tool = defineTool({
			name: "lookup_inventory",
			label: "Inventory lookup",
			description: "Look up current inventory and its receipt.",
			parameters: Type.Object({
				warehouse: Type.Union([Type.Literal("east"), Type.Literal("west")]),
				sku: Type.String(),
			}),
			async execute(callId, params) {
				attempts++;
				appendFileSync(
					join(options.evidenceDir, "tool-attempts.jsonl"),
					`${serialize({ callId, params })}\n`,
				);
				if (params.sku !== "BOLT") throw new Error("Unknown inventory SKU");
				const result: LiveToolCall = {
					...truth,
					warehouse: params.warehouse,
					quantity:
						params.warehouse === "west" ? truth.quantity : truth.quantity + 100,
					receipt:
						params.warehouse === "west"
							? truth.receipt
							: `east-${truth.receipt}`,
				};
				calls.push(result);
				appendFileSync(
					join(options.evidenceDir, "tool-results.jsonl"),
					`${serialize({ callId, result })}\n`,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(result) }],
					details: result,
				};
			},
		});
		session = await createLiveSession({
			scratch,
			baseUrl: capture.baseUrl,
			tool,
		});
		cleanup.sessionClosed = false;
		session.subscribe((event) =>
			appendFileSync(
				join(options.evidenceDir, "events.jsonl"),
				`${serialize(event)}\n`,
			),
		);
		await session.prompt(
			"Plan to look up inventory for BOLT in warehouse east. Do not call any tool yet. Briefly acknowledge and wait.",
		);
		planningText = assistantText(session.messages.at(-1));
		initialToolCalls = attempts;
		await session.prompt(
			"Correction: use warehouse west, not east. Look up inventory for BOLT now. Return only a JSON object with warehouse, sku, quantity, receipt from the tool result.",
		);
		finalText = assistantText(session.messages.at(-1));
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		errors.push(error.message);
	} finally {
		try {
			if (session) {
				save("messages.json", session.messages);
				await session.abort();
				session.dispose();
			}
			cleanup.sessionClosed = true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`session cleanup: ${message}`);
		}
		try {
			if (capture) {
				const closed = await capture.close();
				cleanup.port = closed.port;
				cleanup.captureClosed = closed.closed;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push(`capture cleanup: ${message}`);
		}
		if (scratch) {
			await rm(scratch, { recursive: true, force: true });
			cleanup.scratchRemoved = !existsSync(scratch);
		}
	}
	const evidence: LiveEvidence = {
		initialToolCalls,
		calls,
		finalText,
		wire: capture?.records ?? [],
	};
	const evaluation = evaluateLiveEvidence(evidence, truth);
	const passed =
		evaluation.pass &&
		errors.length === 0 &&
		cleanup.sessionClosed &&
		cleanup.captureClosed &&
		cleanup.scratchRemoved;
	const report: LiveRunReport = {
		verdict: passed ? "pass" : "fail",
		sdk: sdk.name,
		version: sdk.version,
		api: "openai-completions",
		requestedModel: "ollama-cloud/glm-5.3-flash",
		truth,
		evidence,
		evaluation,
		errors,
		cleanup,
		planningText,
		elapsedMs: performance.now() - started,
		runtime: {
			bun: Bun.version,
			platform: process.platform,
			arch: process.arch,
		},
		monetaryCost: null,
	};
	save("report.json", report);
	save("cleanup.json", cleanup);
	return report;
}
