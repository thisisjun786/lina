import type { LifeModelLane, LifeStep } from "./autonomy-types.ts";
import { lifeDigest } from "./life-json.ts";
import { compileSocialPack } from "./social-compile.ts";
import { inspectSocialIntent } from "./social-intent-validation.ts";
import { parseSocialTargetResponse } from "./social-store-validation.ts";
import type { SocialIntentInspection, TargetResponse } from "./social-types.ts";
export function completedLifeModelText(
	step: LifeStep,
	lane: LifeModelLane,
	agentId: string,
): string {
	const records = step.models.filter(
		(r) =>
			r.prepared.request.lane === lane &&
			r.prepared.request.agentId === agentId,
	);
	const row = records[0];
	if (
		records.length !== 1 ||
		!row ||
		row.status !== "completed" ||
		!row.result ||
		row.prepared.request.stepId !== step.id ||
		row.prepared.request.worldId !== step.worldId ||
		row.result.requestId !== row.prepared.request.id ||
		row.result.inputDigest !== row.prepared.inputDigest
	)
		throw Error(`Missing or invalid completed ${lane} result`);
	if (
		Buffer.byteLength(row.result.text) >
		row.prepared.request.limits.maxOutputBytes
	)
		throw Error("Autonomy completed text capacity exceeded");
	return row.result.text;
}
export function completedStepIntent(step: LifeStep): SocialIntentInspection {
	const actor = step.decision.agentId;
	if (!actor) throw Error("Missing selected actor");
	const result = inspectSocialIntent(
		JSON.parse(completedLifeModelText(step, "actor", actor)),
		compileSocialPack(step.source.pack),
	);
	if (
		result.intent.agentId !== actor ||
		result.intent.primitives.length >
			(step.source.config.limits?.maxActorActions ?? 0) ||
		!step.source.pack.autonomy.events
			.find((x) => x.familyId === step.decision.familyId)
			?.capabilityIds.includes(result.intent.capabilityId)
	)
		throw Error("Autonomy actor opportunity mismatch");
	if (step.intent && lifeDigest(step.intent) !== lifeDigest(result.intent))
		throw Error("Autonomy intent differs from saved model text");
	return result;
}
export function completedStepTarget(
	step: LifeStep,
	intent: SocialIntentInspection["intent"],
): TargetResponse | null {
	if (intent.targetAgentId === null) return null;
	const result = parseSocialTargetResponse(
		JSON.parse(completedLifeModelText(step, "target", intent.targetAgentId)),
	);
	if (
		!result ||
		result.agentId !== intent.targetAgentId ||
		result.intentId !== intent.id ||
		(step.targetResponse &&
			lifeDigest(step.targetResponse) !== lifeDigest(result))
	)
		throw Error("Autonomy target differs from saved model text");
	return result;
}
