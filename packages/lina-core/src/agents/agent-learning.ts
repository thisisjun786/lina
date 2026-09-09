import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SourceLookup, SourceProof } from "../source-policy.ts";
import {
	assertLearnedProvenance,
	type LearnedProvenance,
	unionLearnedProofs,
} from "./learned-provenance.ts";
import {
	encodeReflectionReceipt,
	readReflectionReceipt,
} from "./learned-receipt.ts";
import {
	emptyLearningState,
	LEARNED_AXES,
	type LearningState,
	learningRequests,
	parseLearningState,
} from "./learning-state.ts";
import type { Dynamics, ReflectionInput } from "./types.ts";
import { MOOD_TTL_MS } from "./validation.ts";

export const AGENT_LEARNING_SCHEMA = `
CREATE TABLE agent_learning_receipts (agent_id TEXT NOT NULL, request_id TEXT NOT NULL, input_json TEXT NOT NULL, source_proofs TEXT NOT NULL, PRIMARY KEY(agent_id,request_id), FOREIGN KEY(agent_id,request_id) REFERENCES agent_receipts(agent_id,request_id)) STRICT;
CREATE TABLE agent_learning_state (agent_id TEXT PRIMARY KEY REFERENCES agent_profiles(id), data TEXT NOT NULL) STRICT;
CREATE TABLE agent_learning_history (seq INTEGER PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agent_profiles(id), kind TEXT NOT NULL CHECK(kind IN ('reflection','legacy','edit','revert')), change_id INTEGER REFERENCES agent_changes(id), before_state TEXT NOT NULL, after_state TEXT NOT NULL, before_raw TEXT NOT NULL, after_raw TEXT NOT NULL) STRICT;
`;
export class AgentLearning {
	constructor(private readonly db: DatabaseSync) {}
	state(id: string): LearningState {
		const row = this.db
			.prepare("SELECT data FROM agent_learning_state WHERE agent_id=?")
			.get(id);
		return row
			? parseLearningState(JSON.parse(String(row["data"])))
			: emptyLearningState();
	}
	proofs(
		id: string,
		requestId: string,
		lookup: SourceLookup,
	): SourceProof[] | undefined {
		const row = this.db
			.prepare(
				"SELECT input_json,source_proofs FROM agent_learning_receipts WHERE agent_id=? AND request_id=?",
			)
			.get(id, requestId);
		if (!row) return undefined;
		const { input, sourceProofs, bound } = readReflectionReceipt(
			id,
			requestId,
			String(row["input_json"]),
			String(row["source_proofs"]),
		);
		if (!bound) return undefined;
		try {
			return assertLearnedProvenance(
				{ sourceProofs, lookup },
				requestId,
				input.sourceEntryIds,
			);
		} catch {
			return undefined;
		}
	}
	qualified(
		id: string,
		lookup: SourceLookup,
		now: number,
	): { state: LearningState; sourceProofs: SourceProof[] } {
		const state = this.state(id),
			proofs = new Map<string, SourceProof[] | undefined>();
		const current = (requestId: string) => {
			if (!proofs.has(requestId))
				proofs.set(requestId, this.proofs(id, requestId, lookup));
			return proofs.get(requestId);
		};
		const allowed = (ids: string[]) =>
			ids.every((requestId) => current(requestId));
		if (
			state.mood &&
			(!allowed(state.mood.requestIds) || state.mood.value.expiresAt <= now)
		)
			state.mood = null;
		for (const axis of LEARNED_AXES) {
			state.values[axis] = state.values[axis].filter((v) =>
				allowed(v.requestIds),
			);
			state.pending[axis] = state.pending[axis].filter((v) =>
				allowed(v.requestIds),
			);
		}
		if (state.lastRequestId && !current(state.lastRequestId))
			state.lastRequestId = null;
		return {
			state,
			sourceProofs: unionLearnedProofs(
				...learningRequests(state).map((requestId) => current(requestId) ?? []),
			),
		};
	}
	model(id: string, raw: Dynamics, lookup: SourceLookup, now: number) {
		const { state, sourceProofs } = this.qualified(id, lookup, now);
		return {
			dynamics: {
				revision: raw.revision,
				mood: state.mood?.value ?? null,
				interests: state.values.interests.map((v) => v.value),
				preferences: state.values.preferences.map((v) => v.value),
				relationship: state.values.relationship.map((v) => v.value),
				lastRequestId: state.lastRequestId,
			},
			pendingGrowth: {
				interests: state.pending.interests
					.slice(-6)
					.reverse()
					.map((v) => v.value),
				preferences: state.pending.preferences
					.slice(-6)
					.reverse()
					.map((v) => v.value),
				relationship: state.pending.relationship
					.slice(-6)
					.reverse()
					.map((v) => v.value),
			},
			sourceProofs,
		};
	}
	receipt(
		id: string,
		input: ReflectionInput,
		provenance: LearnedProvenance,
	): void {
		const proofs = assertLearnedProvenance(
			provenance,
			input.requestId,
			input.sourceEntryIds,
		);
		const row = this.db
			.prepare(
				"SELECT input_json,source_proofs FROM agent_learning_receipts WHERE agent_id=? AND request_id=?",
			)
			.get(id, input.requestId);
		if (row) {
			const saved = readReflectionReceipt(
				id,
				input.requestId,
				String(row["input_json"]),
				String(row["source_proofs"]),
			);
			if (
				!saved.bound ||
				!isDeepStrictEqual(saved.input, input) ||
				!isDeepStrictEqual(JSON.parse(String(row["source_proofs"])), proofs) ||
				!this.proofs(id, input.requestId, provenance.lookup)
			)
				throw Error("stale or conflicting learned receipt");
			return;
		}
		throw Error("unqualified historical reflection receipt");
	}
	propose(
		id: string,
		input: ReflectionInput,
		provenance: LearnedProvenance,
		now: number,
	): LearningState {
		const before = this.qualified(id, provenance.lookup, now);
		const proofs = unionLearnedProofs(
			assertLearnedProvenance(
				provenance,
				input.requestId,
				input.sourceEntryIds,
			),
			before.sourceProofs,
		);
		this.db
			.prepare("INSERT INTO agent_learning_receipts VALUES(?,?,?,?)")
			.run(
				id,
				input.requestId,
				JSON.stringify(encodeReflectionReceipt(id, input, proofs)),
				JSON.stringify(proofs),
			);
		const state = before.state;
		if (input.mood)
			state.mood = {
				value: { ...input.mood, expiresAt: now + MOOD_TTL_MS },
				requestIds: [input.requestId],
			};
		for (const axis of LEARNED_AXES)
			for (const text of input[axis] ?? []) {
				const value = text.trim().toLocaleLowerCase();
				if (state.values[axis].some((v) => v.value === value)) continue;
				const prior = state.pending[axis].find((v) => v.value === value);
				const requestIds = [
					...new Set([...(prior?.requestIds ?? []), input.requestId]),
				];
				if (requestIds.length >= 2) {
					state.pending[axis] = state.pending[axis].filter(
						(v) => v.value !== value,
					);
					state.values[axis].push({ value, requestIds });
					state.values[axis] = state.values[axis].slice(-16);
				} else if (prior) prior.requestIds = requestIds;
				else {
					state.pending[axis].push({ value, requestIds });
					state.pending[axis] = state.pending[axis].slice(-32);
				}
			}
		state.lastRequestId = input.requestId;
		return parseLearningState(state);
	}
	save(
		id: string,
		state: LearningState,
		kind: string,
		beforeRaw: Dynamics,
		afterRaw: Dynamics,
		changeId: number | null = null,
	): void {
		const before = this.state(id),
			after = parseLearningState(state);
		this.db
			.prepare(
				"INSERT INTO agent_learning_history(agent_id,kind,change_id,before_state,after_state,before_raw,after_raw) VALUES(?,?,?,?,?,?,?)",
			)
			.run(
				id,
				kind,
				changeId,
				JSON.stringify(before),
				JSON.stringify(after),
				JSON.stringify(beforeRaw),
				JSON.stringify(afterRaw),
			);
		this.db
			.prepare(
				"INSERT INTO agent_learning_state VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET data=excluded.data",
			)
			.run(id, JSON.stringify(after));
	}
	edit(id: string, raw: Dynamics): void {
		const state = this.state(id);
		state.pending = emptyLearningState().pending;
		this.save(id, state, "edit", raw, raw);
	}
	revert(
		id: string,
		changeId: number,
		beforeRaw: Dynamics,
		afterRaw: Dynamics,
	): void {
		const row = this.db
			.prepare(
				"SELECT before_state FROM agent_learning_history WHERE agent_id=? AND kind='reflection' AND change_id=?",
			)
			.get(id, changeId);
		this.save(
			id,
			row
				? parseLearningState(JSON.parse(String(row["before_state"])))
				: emptyLearningState(),
			"revert",
			beforeRaw,
			afterRaw,
		);
	}
}
