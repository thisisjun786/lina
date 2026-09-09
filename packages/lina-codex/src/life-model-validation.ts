import {
	parseLifeModelRequest,
	parseLifeModelUsage,
	parsePreparedLifeModel,
} from "../../lina-core/src/world/autonomy-record-validation.ts";
import type {
	LifeModelRequest,
	LifeModelUsage,
	PreparedLifeModelRequest,
} from "../../lina-core/src/world/autonomy-types.ts";
import {
	canonicalLifeJson,
	lifeDigest,
} from "../../lina-core/src/world/life-json.ts";
import { authorRecord } from "./author-native-policy.ts";

// Implementation byte/time bounds are separate from product token admission limits.
export const LIFE_MAX_BYTES = 1_048_576;
export const LIFE_WIRE_OVERHEAD = 65_536;
export const LIFE_UNKNOWN_USAGE: LifeModelUsage = Object.freeze({
	inputTokens: null,
	outputTokens: null,
	totalTokens: null,
});
export function lifeFields(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	canonicalLifeJson(value);
	const row = authorRecord(value);
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((k) => !Object.hasOwn(row, k))
	)
		throw Error("Invalid LIFE fields");
	return row;
}
export function lifeString(value: unknown, max = 256): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.trim() !== value ||
		value.length > max ||
		[...value].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		throw Error("Invalid LIFE identity");
	return value;
}
export function lifeInteger(
	value: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < min ||
		value > max
	)
		throw Error("Invalid LIFE integer");
	return value;
}
export { parseLifeModelRequest as lifeModelRequest };
export function lifePrepared(value: unknown): PreparedLifeModelRequest {
	const prepared = parsePreparedLifeModel(value);
	if (prepared.nativeReference !== lifeReference(prepared.request))
		throw Error("Invalid LIFE native reference");
	return prepared;
}
export function lifeReference(request: LifeModelRequest): string {
	return `life-model-${lifeDigest({ worldId: request.worldId, requestId: request.id })}`;
}
export function lifeUsage(value: unknown): LifeModelUsage {
	canonicalLifeJson(value);
	return parseLifeModelUsage(value);
}
