import type {
	LifeStepFailure,
	WorldAutonomyPort,
} from "../../../lina-core/src/world/autonomy-store-types.ts";
import type {
	LifeLease,
	LifeModelLane,
	LifeModelRecord,
	LifeModelRequest,
	LifeModelResult,
	LifeStep,
	LifeUsageStatus,
} from "../../../lina-core/src/world/autonomy-types.ts";
import { lifeDigest } from "../../../lina-core/src/world/life-json.ts";
import type { LifeModelPort } from "./model-port.ts";
import type { LifeClock } from "./scheduler.ts";

// Implementation bounds; token and call allowances always come from authored configuration.
const MAX_MODEL_BYTES = 256 * 1024;
const MODEL_TIMEOUT_MS = 60_000;

export class LifeExecutionError extends Error {
	constructor(
		readonly reason: LifeStepFailure,
		message: string,
	) {
		super(message);
	}
}

export function lifeLaneId(
	stepId: string,
	lane: string,
	agentId: string,
): string {
	return `life-${lifeDigest({ stepId, lane, agentId })}`;
}

/** Core selection freezes the full-cast bound before any model request is admitted. */
export function requiredLifeModelCalls(step: LifeStep): number {
	return step.decision.maxModelCalls;
}

export function buildLifeRequest(
	step: LifeStep,
	lane: LifeModelLane,
	agentId: string,
	usage: LifeUsageStatus,
	prompt: { systemPrompt: string; input: string },
): LifeModelRequest {
	const config = step.source.config;
	const selector = config.models?.[lane === "director" ? "director" : "actor"];
	const route =
		selector && "tier" in selector
			? step.source.resolvedModels?.[lane === "director" ? "director" : "actor"]
			: selector;
	if (!route || !config.usage)
		throw new LifeExecutionError(
			"unavailable",
			"LIFE model or usage configuration missing",
		);
	const selection =
		step.version === 4
			? step.source.resolvedModels?.[lane === "director" ? "director" : "actor"]
			: undefined;
	if (step.version === 4 && !selection)
		throw new LifeExecutionError(
			"unavailable",
			"Missing frozen LIFE model selection",
		);
	const calls = step.decision.maxModelCalls - step.models.length;
	const inputTokens = Math.floor(
		(config.usage.maxInputTokens -
			usage.inputTokens -
			usage.reservedInputTokens) /
			calls,
	);
	const outputTokens = Math.floor(
		(config.usage.maxOutputTokens -
			usage.outputTokens -
			usage.reservedOutputTokens) /
			calls,
	);
	if (
		calls <= 0 ||
		usage.unknownRequests > 0 ||
		inputTokens <= 0 ||
		outputTokens <= 0
	)
		throw new LifeExecutionError(
			"budget",
			"LIFE token budget or unresolved usage prevents admission",
		);
	if (
		Buffer.byteLength(prompt.systemPrompt) + Buffer.byteLength(prompt.input) >
		MAX_MODEL_BYTES
	)
		throw new LifeExecutionError(
			"budget",
			"LIFE scoped input exceeds byte admission limit",
		);
	return {
		...(selection
			? { version: 3 as const, selection }
			: { version: 1 as const }),
		id: lifeLaneId(step.id, lane, agentId),
		worldId: step.worldId,
		stepId: step.id,
		lane,
		agentId,
		provider: route.provider,
		model: route.model,
		modelSettingsRevision: step.source.modelSettingsRevision,
		...prompt,
		limits: {
			maxInputTokens: inputTokens,
			maxOutputTokens: Math.min(
				outputTokens,
				selection?.maxOutputTokens ?? outputTokens,
			),
			maxInputBytes: MAX_MODEL_BYTES,
			maxOutputBytes: MAX_MODEL_BYTES,
			timeoutMs: MODEL_TIMEOUT_MS,
		},
	};
}

export interface LifeInvocationContext {
	store: Pick<
		WorldAutonomyPort,
		"lifeStatus" | "prepareLifeModel" | "dispatchLifeModel" | "finishLifeModel"
	>;
	model: LifeModelPort;
	clock: LifeClock;
	signal: AbortSignal;
	step(): LifeStep;
	lease(): LifeLease;
	guard(): void;
}

function completed(record: LifeModelRecord): LifeModelResult {
	if (record.status !== "completed" || !record.result)
		throw new LifeExecutionError(
			record.status === "failed" ? "invalid_model_output" : "model_unknown",
			"LIFE model result requires attention",
		);
	const { inputTokens, outputTokens, totalTokens } = record.usage;
	if (
		inputTokens === null ||
		outputTokens === null ||
		totalTokens === null ||
		inputTokens > record.reservation.inputTokens ||
		outputTokens > record.reservation.outputTokens
	)
		throw new LifeExecutionError(
			"budget",
			"LIFE model usage is unknown or exceeds its reservation",
		);
	return record.result;
}

/** Cancellation is not completion: await the owned operation before leaving this scope. */
async function withCutoff<T>(
	context: LifeInvocationContext,
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const timer = new AbortController();
	const cutoff = new AbortController();
	const signal = AbortSignal.any([context.signal, cutoff.signal]);
	const deadline = context.clock.now() + timeoutMs;
	if (!Number.isSafeInteger(deadline))
		throw new LifeExecutionError("unavailable", "Unsafe LIFE request deadline");
	const waiting = context.clock.waitUntil(deadline, timer.signal).then(
		() => {
			cutoff.abort(
				new LifeExecutionError("cancelled", "LIFE model deadline exceeded"),
			);
		},
		(error) => {
			if (!timer.signal.aborted) cutoff.abort(error);
		},
	);
	try {
		const result = await operation(signal);
		signal.throwIfAborted();
		return result;
	} finally {
		timer.abort();
		await waiting;
	}
}

export async function invokeLifeModel(
	context: LifeInvocationContext,
	lane: LifeModelLane,
	agentId: string,
	prompt: () => { systemPrompt: string; input: string },
): Promise<LifeModelResult> {
	context.guard();
	const step = context.step();
	const requestId = lifeLaneId(step.id, lane, agentId);
	let record = step.models.find((row) => row.prepared.request.id === requestId);
	const finish = (
		result: Parameters<WorldAutonomyPort["finishLifeModel"]>[3],
	) =>
		context.store.finishLifeModel(
			step.worldId,
			step.id,
			requestId,
			result,
			context.clock.now(),
		);
	if (record?.status === "completed") return completed(record);
	if (record?.status === "failed") return completed(record);
	if (record) {
		const reconciled = await context.model.reconcile(record.prepared);
		if (reconciled.status !== "not_dispatched")
			return completed(finish(reconciled));
		if (record.status !== "prepared")
			return completed(finish({ status: "unknown" }));
	} else {
		const request = buildLifeRequest(
			step,
			lane,
			agentId,
			context.store.lifeStatus(step.worldId, context.clock.now()).usage,
			prompt(),
		);
		const prepared = await withCutoff(
			context,
			request.limits.timeoutMs,
			(signal) => context.model.prepare(request, signal),
		);
		context.guard();
		record = context.store.prepareLifeModel(
			context.lease(),
			step.id,
			prepared,
			context.clock.now(),
		);
	}
	context.guard();
	const dispatch = context.store.dispatchLifeModel(
		context.lease(),
		step.id,
		requestId,
		context.clock.now(),
	);
	if (!dispatch.dispatched) return completed(dispatch.record);
	let result: LifeModelResult;
	try {
		result = await withCutoff(
			context,
			record.prepared.request.limits.timeoutMs,
			(signal) => context.model.complete(record.prepared, signal),
		);
	} catch (error) {
		let reconciled: Awaited<ReturnType<LifeModelPort["reconcile"]>>;
		try {
			reconciled = await context.model.reconcile(record.prepared);
		} catch {
			reconciled = { status: "unknown" };
		}
		// After durable dispatch, absence of proof must keep the reservation.
		finish(
			reconciled.status === "not_dispatched"
				? { status: "unknown" }
				: reconciled,
		);
		if (context.signal.aborted) throw context.signal.reason;
		if (error instanceof LifeExecutionError && error.reason === "cancelled")
			throw error;
		if (reconciled.status === "completed")
			return completed(
				context
					.step()
					.models.find((row) => row.prepared.request.id === requestId) ??
					record,
			);
		throw new LifeExecutionError(
			reconciled.status === "failed" ? "invalid_model_output" : "model_unknown",
			error instanceof Error ? error.message : "LIFE model failed",
		);
	}
	const saved = finish({ status: "completed", result });
	context.guard();
	return completed(saved);
}
