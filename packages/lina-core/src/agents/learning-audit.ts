import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readReflectionReceipt } from "./learned-receipt.ts";
import {
	emptyLearningState,
	LEARNED_AXES,
	type LearningState,
	learningRequests,
	parseLearningState,
} from "./learning-state.ts";
import type { ReflectionInput } from "./types.ts";

/** Validate durable projections independently of mutable source eligibility. */
export function auditLearning(
	db: DatabaseSync,
	validateRaw: (value: unknown) => void,
): void {
	const inputs = new Map<string, ReflectionInput>();
	const key = (id: string, request: string) => JSON.stringify([id, request]);
	for (const row of db
		.prepare(
			"SELECT agent_id,request_id,input_json,source_proofs FROM agent_learning_receipts",
		)
		.iterate()) {
		const { input } = readReflectionReceipt(
			String(row["agent_id"]),
			String(row["request_id"]),
			String(row["input_json"]),
			String(row["source_proofs"]),
		);
		inputs.set(key(String(row["agent_id"]), input.requestId), input);
	}
	const state = (id: string, data: unknown): LearningState => {
		const s = parseLearningState(JSON.parse(String(data)));
		const input = (r: string) => {
			const result = inputs.get(key(id, r));
			if (!result) throw Error("orphan learned state request");
			return result;
		};
		for (const request of learningRequests(s)) input(request);
		if (s.mood) {
			const { label, reason } = s.mood.value;
			if (
				s.mood.requestIds.length !== 1 ||
				!isDeepStrictEqual(input(s.mood.requestIds[0] ?? "").mood, {
					label,
					reason,
				})
			)
				throw Error("invalid learned mood projection");
		}
		for (const axis of LEARNED_AXES) {
			if (
				s.values[axis].some((v) =>
					s.pending[axis].some((p) => p.value === v.value),
				)
			)
				throw Error("duplicate learned projection");
			for (const group of ["values", "pending"] as const)
				for (const v of s[group][axis]) {
					if (
						(group === "values"
							? v.requestIds.length < 2
							: v.requestIds.length !== 1) ||
						v.value !== v.value.trim().toLocaleLowerCase() ||
						v.requestIds.some(
							(r) =>
								!input(r)[axis]?.some(
									(text) => text.trim().toLocaleLowerCase() === v.value,
								),
						)
					)
						throw Error("invalid learned value projection");
				}
		}
		return s;
	};
	const latest = new Map<string, LearningState>();
	for (const row of db
		.prepare("SELECT * FROM agent_learning_history ORDER BY seq")
		.iterate()) {
		const id = String(row["agent_id"]),
			before = state(id, row["before_state"]),
			after = state(id, row["after_state"]);
		if (!isDeepStrictEqual(before, latest.get(id) ?? emptyLearningState()))
			throw Error("invalid learned history chain");
		const beforeRaw = JSON.parse(String(row["before_raw"])),
			afterRaw = JSON.parse(String(row["after_raw"]));
		validateRaw(beforeRaw);
		validateRaw(afterRaw);
		if (row["change_id"] !== null) {
			const change = db
				.prepare(
					"SELECT agent_id,kind,before_state,after_state FROM agent_changes WHERE id=?",
				)
				.get(Number(row["change_id"]));
			if (
				!change ||
				change["agent_id"] !== id ||
				change["kind"] !== "reflection" ||
				row["kind"] !== "reflection" ||
				!isDeepStrictEqual(
					JSON.parse(String(change["before_state"])),
					beforeRaw,
				) ||
				!isDeepStrictEqual(JSON.parse(String(change["after_state"])), afterRaw)
			)
				throw Error("invalid learned history change");
		}
		latest.set(id, after);
	}
	for (const row of db
		.prepare("SELECT agent_id,data FROM agent_learning_state")
		.iterate()) {
		const id = String(row["agent_id"]),
			s = state(id, row["data"]);
		if (!latest.has(id) || !isDeepStrictEqual(latest.get(id), s))
			throw Error("invalid current learned state projection");
		latest.delete(id);
	}
	if (latest.size) throw Error("missing current learned state");
}
