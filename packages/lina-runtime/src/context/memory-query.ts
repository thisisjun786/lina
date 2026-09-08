import { Type } from "typebox";
import {
	archiveText,
	isOrdinaryArchiveEntry,
} from "../../../lina-core/src/context/archive.ts";
import {
	captureSourceProofs,
	type SourceProof,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import { contentHash } from "../../../lina-memory/src/engine/reasoning.ts";
import type { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import type { EngineRecord } from "../../../lina-memory/src/engine/types.ts";
import type { LinaHost } from "../host.ts";
import {
	defaultEnginePolicy,
	type EnginePolicySnapshot,
} from "./policy-settings.ts";
import { searchContextHistory } from "./tools.ts";

type Reason = (
	input: string,
	signal: AbortSignal,
	beforeDispatch?: () => void,
) => Promise<string>;
const DELIVERY_GUARDS = new WeakMap<object, () => void>();
const PER_SOURCE = 2400;
const INCOMPLETE_ANSWER =
	"Insufficient evidence to answer from the supplied sources.";

export type MemoryQueryCoverage = {
	searchRounds: number;
	visitedSources: number;
	incomplete: boolean;
	reason?: string;
};

function policyFingerprint(policy: EnginePolicySnapshot): string {
	return JSON.stringify({
		revision: policy.revision,
		version: policy.version,
		memory: policy.memory,
	});
}

function parseQueries(answer: string): string[] | null {
	let plan: unknown;
	try {
		plan = JSON.parse(answer);
	} catch {
		return null;
	}
	if (
		!plan ||
		typeof plan !== "object" ||
		Array.isArray(plan) ||
		!("queries" in plan)
	)
		return null;
	if (Object.getOwnPropertyNames(plan).some((key) => key !== "queries"))
		throw Error("Invalid memory search request");
	const queries = (plan as { queries: unknown }).queries;
	if (
		!Array.isArray(queries) ||
		queries.length > 3 ||
		queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 512)
	)
		throw Error("Invalid memory search request");
	return queries;
}

function qualified(
	record: EngineRecord,
	lookup: (id: string) => ReturnType<DurableStore["sourceEntry"]>,
): boolean {
	return (
		sourceProofsCurrent(record.sourceProofs ?? [], lookup) &&
		record.sources.every((source) =>
			isOrdinaryArchiveEntry(lookup(source.entryId)),
		)
	);
}

function recordPayload(record: EngineRecord) {
	return {
		id: record.id,
		revision: record.revision,
		text: record.text,
		subject: record.subject,
		kind: record.kind,
		support: record.support,
		evidence: record.evidence,
		validFrom: record.validFrom,
		expiresAt: record.expiresAt,
		sources: record.sources.map((s) => s.entryId),
		...(record.reasoning
			? {
					reasoning: {
						kind: record.reasoning.kind,
						premises: record.reasoning.premises.map((p) => ({
							recordId: p.recordId,
							revision: p.revision,
							contentHash: p.contentHash,
						})),
					},
				}
			: {}),
	};
}

function packedLength(
	query: string,
	remainingSearches: number,
	records: EngineRecord[],
	sources: { id: string; text: string; clipped: boolean }[],
): number {
	return JSON.stringify({
		remainingSearches,
		searchContract: remainingSearches
			? 'If evidence is insufficient, return only {"queries":["literal search phrase"]}, at most 3 phrases. Otherwise answer from evidence with source IDs.'
			: "No further searches. Answer only from supplied evidence, or state what is missing.",
		query,
		records: records.map(recordPayload),
		sources,
	}).length;
}

/** Read-only synthesis with bounded originals, never an alternative memory writer. */
export async function queryMemory(
	query: string,
	mind: EngineStore,
	journal: DurableStore,
	reason: Reason,
	signal: AbortSignal,
	policyGetter: () => EnginePolicySnapshot = defaultEnginePolicy,
) {
	signal.throwIfAborted();
	if (!query.trim() || query.length > 2000)
		throw Error("Invalid memory question");
	const state = mind.state();
	const capturedPolicy = policyGetter();
	const capturedFingerprint = policyFingerprint(capturedPolicy);
	const maxSearchRounds = capturedPolicy.memory.maxSearchRounds;
	const maxVisits = capturedPolicy.memory.maxVisits;
	const lookup = (id: string) => journal.sourceEntry(id);
	const proofs: SourceProof[] = [];
	const selectedIds: string[] = [];
	const assertCurrent = (captured = proofs) => {
		signal.throwIfAborted();
		if (policyFingerprint(policyGetter()) !== capturedFingerprint)
			throw Error(
				"Memory source provenance changed during query; retry with current evidence",
			);
		if (
			(captured.length &&
				!sourceProofsCurrent(
					[...new Map(captured.map((p) => [p.entryId, p])).values()],
					lookup,
				)) ||
			mind.snapshot().revision !== state.revision ||
			(selectedIds.length > 0 && !mind.currentRecords(selectedIds))
		)
			throw Error(
				"Memory source provenance changed during query; retry with current evidence",
			);
	};
	const maxInput = capturedPolicy.memory.inputChars;
	if (
		Math.max(
			packedLength(query, maxSearchRounds, [], []),
			packedLength(query, 0, [], []),
		) > maxInput
	)
		throw Error("Memory query input budget is smaller than the question");
	let incomplete = false;
	let incompleteReason: string | undefined;
	const markIncomplete = (reason: string) => {
		incomplete = true;
		incompleteReason ??= reason;
	};
	const records: EngineRecord[] = [];
	const sources: { id: string; text: string; clipped: boolean }[] = [];
	const fits = (
		nextRecords: EngineRecord[],
		nextSources: { id: string; text: string; clipped: boolean }[],
	) =>
		packedLength(query, maxSearchRounds, nextRecords, nextSources) <=
			maxInput && packedLength(query, 0, nextRecords, nextSources) <= maxInput;
	const addRecord = (record: EngineRecord): boolean => {
		if (records.some((existing) => existing.id === record.id)) return true;
		if (records.length >= 20 || !fits([...records, record], sources)) {
			markIncomplete("budget-exhausted");
			return false;
		}
		records.push(record);
		selectedIds.push(record.id);
		proofs.push(...(record.sourceProofs ?? []));
		return true;
	};
	const addSource = (id: string, needle?: string): boolean => {
		if (sources.some((source) => source.id === id)) return false;
		if (sources.length >= maxVisits) {
			markIncomplete("budget-exhausted");
			return false;
		}
		if (mind.sourceInvalidated(id)) return false;
		const entry = lookup(id);
		if (!isOrdinaryArchiveEntry(entry)) return false;
		const all = archiveText(entry);
		const position = needle ? all.indexOf(needle) : -1;
		const startAt = Math.max(0, position === -1 ? 0 : position - 200);
		let take = Math.min(PER_SOURCE, Math.max(0, all.length - startAt));
		const make = (n: number) => ({
			id,
			text: all.slice(startAt, startAt + n),
			clipped: startAt > 0 || n < all.length - startAt,
		});
		let candidate = make(take);
		while (take > 0 && !fits(records, [...sources, candidate])) {
			take = Math.floor(take / 2);
			candidate = make(take);
		}
		if (
			take <= 0 ||
			!candidate.text ||
			!fits(records, [...sources, candidate])
		) {
			markIncomplete("budget-exhausted");
			return false;
		}
		proofs.push(...captureSourceProofs([id], lookup));
		sources.push(candidate);
		return true;
	};
	const exact = mind.recall(query, { limit: 12 });
	const candidates = [
		...new Map([...exact, ...state.records].map((r) => [r.id, r])).values(),
	].filter((record) => qualified(record, lookup));
	for (const record of candidates.slice(0, 20)) {
		if (!addRecord(record)) break;
		for (const source of record.sources)
			addSource(source.entryId, source.quote);
	}
	if (candidates.length > records.length) markIncomplete("budget-exhausted");
	const visiting = new Set<string>();
	const byId = new Map(
		mind
			.reasoningCandidates()
			.filter((record) => qualified(record, lookup))
			.map((record) => [record.id, record]),
	);
	const walkPremises = (record: EngineRecord) => {
		for (const premise of record.reasoning?.premises ?? []) {
			if (visiting.has(premise.recordId)) continue;
			visiting.add(premise.recordId);
			const found = byId.get(premise.recordId);
			if (
				!found ||
				contentHash(found) !== premise.contentHash ||
				!qualified(found, lookup)
			) {
				markIncomplete("missing-chain");
				continue;
			}
			if (!addRecord(found)) continue;
			for (const source of found.sources)
				addSource(source.entryId, source.quote);
			walkPremises(found);
		}
	};
	for (const record of [...records]) walkPremises(record);
	const input = (remainingSearches: number) => {
		const packed = JSON.stringify({
			remainingSearches,
			searchContract: remainingSearches
				? 'If evidence is insufficient, return only {"queries":["literal search phrase"]}, at most 3 phrases. Otherwise answer from evidence with source IDs.'
				: "No further searches. Answer only from supplied evidence, or state what is missing.",
			query,
			records: records.map(recordPayload),
			sources,
		});
		if (packed.length > maxInput) {
			markIncomplete("budget-exhausted");
			while (
				packedLength(query, remainingSearches, records, sources) > maxInput
			) {
				if (sources.length) sources.pop();
				else if (records.length) {
					const dropped = records.pop();
					if (dropped) {
						const index = selectedIds.lastIndexOf(dropped.id);
						if (index >= 0) selectedIds.splice(index, 1);
					}
				} else break;
			}
			return JSON.stringify({
				remainingSearches,
				searchContract: remainingSearches
					? 'If evidence is insufficient, return only {"queries":["literal search phrase"]}, at most 3 phrases. Otherwise answer from evidence with source IDs.'
					: "No further searches. Answer only from supplied evidence, or state what is missing.",
				query,
				records: records.map(recordPayload),
				sources,
			});
		}
		return packed;
	};
	const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	const callReason = async (remainingSearches: number) => {
		assertCurrent();
		const text = await reason(input(remainingSearches), boundedSignal, () =>
			assertCurrent(),
		);
		assertCurrent();
		return text;
	};
	let remaining = maxSearchRounds;
	let searchRounds = 0;
	let answer = await callReason(remaining);
	while (true) {
		const queries = parseQueries(answer);
		if (!queries) break;
		const canSearch =
			remaining > 0 &&
			sources.length < maxVisits &&
			packedLength(query, remaining, records, sources) < maxInput;
		if (!canSearch) {
			incomplete = true;
			incompleteReason ??= remaining <= 0 ? "query-only" : "budget-exhausted";
			if (remaining !== 0) {
				remaining = 0;
				answer = await callReason(0);
				if (parseQueries(answer)) answer = INCOMPLETE_ANSWER;
			} else answer = INCOMPLETE_ANSWER;
			break;
		}
		for (const term of queries) {
			boundedSignal.throwIfAborted();
			for (const hit of searchContextHistory(journal, term, { limit: 8 })
				.messages)
				addSource(hit.entryId, term);
		}
		remaining -= 1;
		searchRounds += 1;
		answer = await callReason(remaining);
	}
	if (parseQueries(answer)) {
		incomplete = true;
		incompleteReason ??= "query-only";
		answer = INCOMPLETE_ANSWER;
	}
	signal.throwIfAborted();
	if (mind.snapshot().revision !== state.revision)
		throw Error("Memory changed during query; retry with current evidence");
	assertCurrent();
	const coverage: MemoryQueryCoverage = {
		searchRounds,
		visitedSources: sources.length,
		incomplete,
		...(incomplete && incompleteReason ? { reason: incompleteReason } : {}),
	};
	const result = {
		answer: answer.slice(0, 8000),
		sources: sources.map((s) => s.id),
		coverage,
	};
	const originalProofs = proofs.map((proof) => ({ ...proof }));
	DELIVERY_GUARDS.set(result, () => assertCurrent(originalProofs));
	return result;
}
export function installMemoryQuery(
	host: LinaHost,
	mind: EngineStore,
	journal: DurableStore,
	reason: Reason,
	policyGetter: () => EnginePolicySnapshot = defaultEnginePolicy,
) {
	host.registerTool({
		name: "lina_memory_query",
		label: "기억에서 확인",
		description:
			"Read and reason over this assistant room's own source-linked memories. Gives bounded original evidence and an inferred answer, not proof of factual truth. No memory changes. Use history search and source expansion for additional details.",
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 2000 }),
		}),
		async execute(_id, { query }, signal) {
			const result = await queryMemory(
				query,
				mind,
				journal,
				reason,
				signal ?? new AbortController().signal,
				policyGetter,
			);
			const beforeDeliver = DELIVERY_GUARDS.get(result);
			if (!beforeDeliver) throw Error("Memory query provenance unavailable");
			beforeDeliver();
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
				beforeDeliver,
			};
		},
	});
}
