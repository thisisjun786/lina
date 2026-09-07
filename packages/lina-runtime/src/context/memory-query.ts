import { Type } from "typebox";
import { archiveText } from "../../../lina-core/src/context/archive.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import type { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import type { LinaHost } from "../host.ts";

type Reason = (input: string, signal: AbortSignal) => Promise<string>;
/** Read-only synthesis with bounded originals, never an alternative memory writer. */
export async function queryMemory(
	query: string,
	mind: EngineStore,
	journal: DurableStore,
	reason: Reason,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!query.trim() || query.length > 2000)
		throw Error("Invalid memory question");
	const state = mind.state();
	const exact = mind.recall(query, { limit: 12 });
	const records = [
		...new Map([...exact, ...state.records].map((r) => [r.id, r])).values(),
	].slice(0, 20);
	const ids = [
		...new Set(records.flatMap((r) => r.sources.map((s) => s.entryId))),
	].slice(0, 24);
	const sources: { id: string; text: string; clipped: boolean }[] = [];
	let budget = 22000;
	for (const id of ids) {
		const e = journal.entry(id);
		if (!e) continue;
		const all = archiveText(e);
		const quote = records
			.flatMap((r) => r.sources)
			.find((s) => s.entryId === id)?.quote;
		const position = quote ? all.indexOf(quote) : -1;
		const offset = Math.max(0, position - 200);
		const text = all.slice(offset, offset + Math.min(2400, budget));
		if (!text) break;
		sources.push({ id, text, clipped: text.length < all.length });
		budget -= text.length;
	}
	const revision = state.revision;
	const input = (remainingSearches: number) =>
		JSON.stringify({
			remainingSearches,
			searchContract: remainingSearches
				? 'If evidence is insufficient, return only {"queries":["literal search phrase"]}, at most 3 phrases. Otherwise answer from evidence with source IDs.'
				: "No further searches. Answer only from supplied evidence, or state what is missing.",
			query,
			records: records.map((r) => ({
				id: r.id,
				text: r.text,
				subject: r.subject,
				kind: r.kind,
				support: r.support,
				evidence: r.evidence,
				validFrom: r.validFrom,
				expiresAt: r.expiresAt,
				sources: r.sources.map((s) => s.entryId),
			})),
			sources,
		});
	const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	let answer = await reason(input(1), boundedSignal);
	let plan: unknown;
	try {
		plan = JSON.parse(answer);
	} catch {
		plan = null;
	}
	if (plan && typeof plan === "object" && "queries" in plan) {
		const queries = plan.queries;
		if (
			!Array.isArray(queries) ||
			queries.length > 3 ||
			queries.some((q) => typeof q !== "string" || !q.trim() || q.length > 512)
		)
			throw Error("Invalid memory search request");
		for (const term of queries as string[]) {
			boundedSignal.throwIfAborted();
			for (const hit of journal.search(term, { limit: 8 }).messages) {
				if (
					mind.sourceInvalidated(hit.entryId) ||
					sources.some((s) => s.id === hit.entryId) ||
					sources.length >= 32 ||
					budget <= 0
				)
					continue;
				const entry = journal.entry(hit.entryId);
				if (!entry) continue;
				const all = archiveText(entry);
				const start = Math.max(0, all.indexOf(term) - 200);
				const text = all.slice(start, start + Math.min(2400, budget));
				sources.push({
					id: hit.entryId,
					text,
					clipped: text.length < all.length,
				});
				budget -= text.length;
			}
		}
		answer = await reason(input(0), boundedSignal);
	}
	signal.throwIfAborted();
	if (mind.snapshot().revision !== revision)
		throw Error("Memory changed during query; retry with current evidence");
	return { answer: answer.slice(0, 8000), sources: sources.map((s) => s.id) };
}
export function installMemoryQuery(
	host: LinaHost,
	mind: EngineStore,
	journal: DurableStore,
	reason: Reason,
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
			);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
