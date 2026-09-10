import { z } from "zod";

export type LiveTruth = {
	readonly warehouse: "west";
	readonly sku: "BOLT";
	readonly quantity: number;
	readonly receipt: string;
};

export type LiveToolCall = {
	readonly warehouse: string;
	readonly sku: string;
	readonly quantity: number;
	readonly receipt: string;
};

export type LiveWire = {
	readonly request: unknown;
	readonly status: number;
	readonly response: string;
};

export type LiveEvidence = {
	readonly initialToolCalls: number;
	readonly calls: readonly LiveToolCall[];
	readonly finalText: string;
	readonly wire: readonly LiveWire[];
};

export function evaluateLiveEvidence(
	evidence: LiveEvidence,
	truth: LiveTruth,
): {
	pass: boolean;
	failures: readonly string[];
	usage: { inputTokens: number | null; outputTokens: number | null };
	responseModels: readonly string[];
} {
	const failures: string[] = [];
	const responseModels = new Set<string>();
	const expected = z.strictObject({
		warehouse: z.literal(truth.warehouse),
		sku: z.literal(truth.sku),
		quantity: z.literal(truth.quantity),
		receipt: z.literal(truth.receipt),
	});
	if (evidence.initialToolCalls !== 0) failures.push("initial-tool-call");
	if (
		evidence.calls.length !== 1 ||
		!expected.safeParse(evidence.calls[0]).success
	)
		failures.push("lookup-mismatch");
	try {
		if (!expected.safeParse(JSON.parse(evidence.finalText)).success)
			failures.push("final-mismatch");
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		failures.push("final-json");
	}
	if (evidence.wire.length === 0 || evidence.wire.length > 6)
		failures.push("request-count");
	let inputTokens: number | null = 0;
	let outputTokens: number | null = 0;
	const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
	const usageSchema = z.object({
		input_tokens: count.optional(),
		output_tokens: count.optional(),
		total_tokens: count.optional(),
	});
	const modelRequest = z.object({
		model: z.literal("ollama-cloud/glm-5.3-flash"),
	});
	for (const [index, wire] of evidence.wire.entries()) {
		if (
			!Number.isInteger(wire.status) ||
			wire.status < 200 ||
			wire.status >= 300
		)
			failures.push(`http-${index}`);
		if (!modelRequest.safeParse(wire.request).success)
			failures.push(`request-model-${index}`);
		let sawModel = false;
		let finished = false;
		let input: number | null = null;
		let output: number | null = null;
		for (const frame of wire.response.replaceAll("\r\n", "\n").split("\n\n")) {
			const data = frame
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) continue;
			if (data.trim() === "[DONE]") continue;
			let raw: unknown;
			try {
				raw = JSON.parse(data);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				failures.push(`stream-json-${index}`);
				continue;
			}
			const parsed = z.record(z.string(), z.unknown()).safeParse(raw);
			if (!parsed.success) {
				failures.push(`stream-shape-${index}`);
				continue;
			}
			if (parsed.data["type"] === "error")
				failures.push(`stream-error-${index}`);
			const rawResponse = parsed.data["response"];
			if (rawResponse === undefined) continue;
			const response = z.record(z.string(), z.unknown()).safeParse(rawResponse);
			if (!response.success) {
				failures.push(`response-shape-${index}`);
				continue;
			}
			if (parsed.data["type"] === "response.completed") {
				if (response.data["status"] === "completed") finished = true;
				else failures.push(`response-status-${index}`);
			}
			if (
				parsed.data["type"] === "response.failed" ||
				parsed.data["type"] === "response.incomplete"
			)
				failures.push(`response-status-${index}`);
			const model = response.data["model"];
			if (model !== undefined) {
				if (
					model === "glm-5.3-flash" ||
					model === "ollama-cloud/glm-5.3-flash"
				) {
					sawModel = true;
					responseModels.add(model);
				} else failures.push(`response-model-${index}`);
			}
			const rawUsage = response.data["usage"];
			if (rawUsage === undefined || rawUsage === null) continue;
			const usage = usageSchema.safeParse(rawUsage);
			if (!usage.success) {
				failures.push(`usage-${index}`);
				continue;
			}
			input = usage.data.input_tokens ?? null;
			output = usage.data.output_tokens ?? null;
			if (output !== null && output > 4096)
				failures.push(`output-budget-${index}`);
			if (
				input !== null &&
				output !== null &&
				usage.data.total_tokens !== undefined &&
				usage.data.total_tokens !== input + output
			)
				failures.push(`usage-total-${index}`);
		}
		if (!sawModel) failures.push(`response-model-missing-${index}`);
		if (!finished) failures.push(`stream-incomplete-${index}`);
		if (input === null || inputTokens === null) inputTokens = null;
		else inputTokens += input;
		if (output === null || outputTokens === null) outputTokens = null;
		else outputTokens += output;
	}
	return {
		pass: failures.length === 0,
		failures,
		usage: { inputTokens, outputTokens },
		responseModels: [...responseModels],
	};
}
