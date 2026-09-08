import type { Dynamics } from "./types.ts";
import { boundedId, boundedText, MAX_ITEM } from "./validation.ts";
export const LEARNED_AXES = [
	"interests",
	"preferences",
	"relationship",
] as const;
export type LearnedAxis = (typeof LEARNED_AXES)[number];
export interface LearnedValue {
	value: string;
	requestIds: string[];
}
export interface LearningState {
	mood: { value: NonNullable<Dynamics["mood"]>; requestIds: string[] } | null;
	values: Record<LearnedAxis, LearnedValue[]>;
	pending: Record<LearnedAxis, LearnedValue[]>;
	lastRequestId: string | null;
}
export function emptyLearningState(): LearningState {
	return {
		mood: null,
		values: { interests: [], preferences: [], relationship: [] },
		pending: { interests: [], preferences: [], relationship: [] },
		lastRequestId: null,
	};
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== fields.length ||
		fields.some((k) => !Object.hasOwn(value, k))
	)
		throw Error("invalid learned state fields");
	return value as Record<string, unknown>;
}
function ids(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > 65536)
		throw Error("invalid learned request ids");
	const result = value.map((v) => boundedId(v, "learned request"));
	if (new Set(result).size !== result.length)
		throw Error("duplicate learned request");
	return result;
}
export function parseLearningState(value: unknown): LearningState {
	const raw = object(value, ["mood", "values", "pending", "lastRequestId"]),
		state = emptyLearningState();
	for (const group of ["values", "pending"] as const) {
		const axes = object(raw[group], [...LEARNED_AXES]);
		for (const axis of LEARNED_AXES) {
			const list = axes[axis];
			if (!Array.isArray(list) || list.length > (group === "values" ? 16 : 32))
				throw Error("invalid learned state bound");
			state[group][axis] = list.map((v) => {
				const item = object(v, ["value", "requestIds"]);
				return {
					value: boundedText(item["value"], "learned value", MAX_ITEM),
					requestIds: ids(item["requestIds"]),
				};
			});
			if (new Set(state[group][axis].map((v) => v.value)).size !== list.length)
				throw Error("duplicate learned value");
		}
	}
	if (raw["mood"] !== null) {
		const mood = object(raw["mood"], ["value", "requestIds"]),
			v = object(mood["value"], ["label", "reason", "expiresAt"]);
		const expiresAt = v["expiresAt"];
		if (
			typeof expiresAt !== "number" ||
			!Number.isSafeInteger(expiresAt) ||
			expiresAt < 0 ||
			expiresAt > 8640000000000000
		)
			throw Error("invalid learned mood expiry");
		state.mood = {
			value: {
				label: boundedText(v["label"], "mood label", MAX_ITEM),
				reason: boundedText(v["reason"], "mood reason", MAX_ITEM),
				expiresAt,
			},
			requestIds: ids(mood["requestIds"]),
		};
	}
	state.lastRequestId =
		raw["lastRequestId"] === null
			? null
			: boundedId(raw["lastRequestId"], "learned request");
	return state;
}
export function learningRequests(state: LearningState): string[] {
	return [
		...new Set([
			...(state.mood?.requestIds ?? []),
			...LEARNED_AXES.flatMap((axis) =>
				[...state.values[axis], ...state.pending[axis]].flatMap(
					(v) => v.requestIds,
				),
			),
			...(state.lastRequestId ? [state.lastRequestId] : []),
		]),
	];
}
