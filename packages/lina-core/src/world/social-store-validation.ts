import {
	enumeration,
	identifier,
	jsonBoundary,
	revision,
} from "./life-json.ts";
import { parseIdentityPolicy } from "./life-validation.ts";
import type { SocialPrepareRequest } from "./social-store-types.ts";
import type { SocialLimits, TargetResponse } from "./social-types.ts";
import { fields, integer, MAX_WORLD_BYTES } from "./validation.ts";

export function parseSocialStoreLimits(value: unknown): SocialLimits {
	fields(value, [
		"maxOperations",
		"maxBindings",
		"maxDepth",
		"maxBytes",
		"maxHistoryEntries",
		"maxTraceEntries",
	]);
	integer(value.maxOperations, "social operations", 1, 1_000_000);
	integer(value.maxBindings, "social bindings", 1, 4096);
	integer(value.maxDepth, "social depth", 1, 32);
	integer(value.maxBytes, "social bytes", 1, MAX_WORLD_BYTES);
	integer(value.maxHistoryEntries, "social history", 1, 4096);
	integer(value.maxTraceEntries, "social trace", 1, 4096);
	return {
		maxOperations: value.maxOperations,
		maxBindings: value.maxBindings,
		maxDepth: value.maxDepth,
		maxBytes: value.maxBytes,
		maxHistoryEntries: value.maxHistoryEntries,
		maxTraceEntries: value.maxTraceEntries,
	};
}
export function parseSocialTargetResponse(
	value: unknown,
): TargetResponse | null {
	if (value === null) return null;
	fields(value, ["intentId", "agentId", "decision"]);
	return {
		intentId: identifier(value.intentId),
		agentId: identifier(value.agentId),
		decision: enumeration(value.decision, ["accept", "reject"]),
	};
}
export function parseSocialPrepareRequest(
	value: unknown,
): SocialPrepareRequest {
	jsonBoundary(value);
	fields(value, [
		"version",
		"worldId",
		"requestId",
		"intent",
		"targetResponse",
		"identity",
		"simulationTime",
		"limits",
	]);
	if (value.version !== 1)
		throw Error("Unsupported social preparation version");
	return {
		version: 1,
		worldId: identifier(value.worldId),
		requestId: identifier(value.requestId),
		intent: structuredClone(value.intent),
		targetResponse: parseSocialTargetResponse(value.targetResponse),
		identity: parseIdentityPolicy(value.identity),
		simulationTime: revision(value.simulationTime),
		limits: parseSocialStoreLimits(value.limits),
	};
}
