import type { WorldAutonomyPort } from "../../../lina-core/src/world/autonomy-store-types.ts";
import { prepareAutonomyObservation } from "../../../lina-core/src/world/autonomy-transition.ts";
import { buildLifeModelInput } from "../../../lina-core/src/world/autonomy-views.ts";
import { compileSocialPack } from "../../../lina-core/src/world/social-compile.ts";
import { inspectSocialIntent } from "../../../lina-core/src/world/social-intent-validation.ts";
import type {
	SocialPreparedResolution,
	WorldSocialPort,
} from "../../../lina-core/src/world/social-store-types.ts";
import { MAX_WORLD_BYTES } from "../../../lina-core/src/world/validation.ts";
import {
	invokeLifeModel,
	LifeExecutionError,
	type LifeInvocationContext,
	lifeLaneId,
	requiredLifeModelCalls,
} from "./actor.ts";
import type { SocialEnginePort } from "./social/port.ts";

export interface LifeDirectorContext extends LifeInvocationContext {
	store: WorldAutonomyPort & WorldSocialPort;
	engine: SocialEnginePort;
	entropy(): number;
}

function decodeSaved<T>(decode: () => T): T {
	try {
		return decode();
	} catch (error) {
		throw new LifeExecutionError(
			"invalid_model_output",
			error instanceof Error ? error.message : "Invalid LIFE model output",
		);
	}
}

async function resolveSocial(
	context: LifeDirectorContext,
): Promise<SocialPreparedResolution> {
	context.guard();
	const step = context.step();
	const evaluation = step.source.config.limits?.evaluation;
	if (!evaluation)
		throw new LifeExecutionError(
			"unavailable",
			"LIFE evaluation limits missing",
		);
	let social = context.store.prepareSocialResolution(
		{
			version: 2,
			stepId: step.id,
			worldId: step.worldId,
			requestId: lifeLaneId(step.id, "social", step.decision.agentId ?? "none"),
			intent: step.intent,
			targetResponse: step.targetResponse,
			identity: step.source.identity,
			simulationTime: step.decision.simulationTime,
			limits: {
				maxOperations: evaluation.maxOperations,
				maxBindings: evaluation.maxRecords,
				maxDepth: evaluation.maxDepth,
				maxBytes: MAX_WORLD_BYTES,
				maxHistoryEntries: 4096,
				maxTraceEntries: 4096,
			},
		},
		context.entropy,
	);
	if (social.result) return social;
	if ("kind" in social.input)
		throw new LifeExecutionError(
			"engine_error",
			"Unexpected incomplete extension resolution",
		);
	try {
		const result = await context.engine.resolve(social.input, context.signal);
		context.guard();
		social = context.store.finishSocialResolution(
			step.worldId,
			social.requestId,
			result,
		);
	} catch (error) {
		context.signal.throwIfAborted();
		if (error instanceof LifeExecutionError) throw error;
		throw new LifeExecutionError(
			"engine_error",
			error instanceof Error ? error.message : "Social resolution failed",
		);
	}
	return social;
}

/** All selection, decoding, perception and acceptance semantics stay in core. */
export async function runLifeDirector(
	context: LifeDirectorContext,
): Promise<void> {
	let step = context.step();
	if (step.decision.kind === "quiet") {
		context.guard();
		context.store.prepareLifeObservations(
			context.lease(),
			step.id,
			null,
			context.clock.now(),
		);
		context.store.finishLifeStep(context.lease(), step.id, context.clock.now());
		return;
	}
	const required = requiredLifeModelCalls(step);
	const configured = step.source.config.limits?.maxModelCalls ?? 0;
	if (configured < required)
		throw new LifeExecutionError(
			"budget",
			`LIFE call budget requires ${required} calls; configured ${configured}`,
		);
	const actorId = step.decision.agentId;
	if (!actorId)
		throw new LifeExecutionError("stale", "LIFE selected actor missing");
	for (const lane of ["director", "actor"] as const)
		await invokeLifeModel(context, lane, actorId, () =>
			buildLifeModelInput(context.step(), lane, actorId),
		);
	context.guard();
	step = decodeSaved(() =>
		context.store.recordLifeIntention(
			context.lease(),
			step.id,
			context.clock.now(),
		),
	);
	const inspection = decodeSaved(() =>
		inspectSocialIntent(step.intent, compileSocialPack(step.source.pack)),
	);
	let social: SocialPreparedResolution | null = null;
	if (inspection.kind === "intent") {
		const targetId = inspection.intent.targetAgentId;
		if (targetId !== null) {
			await invokeLifeModel(context, "target", targetId, () =>
				buildLifeModelInput(context.step(), "target", targetId),
			);
			context.guard();
			step = decodeSaved(() =>
				context.store.recordLifeTarget(
					context.lease(),
					step.id,
					context.clock.now(),
				),
			);
		}
		social = await resolveSocial(context);
	}
	context.guard();
	step = context.store.prepareLifeObservations(
		context.lease(),
		step.id,
		social?.requestId ?? null,
		context.clock.now(),
	);
	// Persist the canonical recipient list before requesting its first reflection.
	const observation = prepareAutonomyObservation(step, social);
	if (step.reflectionAgentIds === null)
		throw new LifeExecutionError(
			"stale",
			"LIFE reflection recipients were not persisted",
		);
	for (const agentId of step.reflectionAgentIds)
		await invokeLifeModel(context, "reflection", agentId, () =>
			buildLifeModelInput(context.step(), "reflection", agentId, observation),
		);
	context.guard();
	decodeSaved(() =>
		context.store.finishLifeStep(context.lease(), step.id, context.clock.now()),
	);
}
