import {
	ENGINE_MOOD_TTL_MS,
	ENGINE_SOURCES_MAX,
	type EngineRecord,
	type LookupEntry,
	type Observation,
	type SourceQuote,
} from "./types.ts";
import { recordId } from "./validation.ts";

export function sameValue(old: EngineRecord, candidate: Observation): boolean {
	return (
		old.status !== "retracted" &&
		old.text === candidate.text &&
		old.evidence === candidate.evidence &&
		old.status === (candidate.status ?? "active")
	);
}
export function mergeSources(sources: SourceQuote[]): SourceQuote[] {
	const unique = new Map(
		sources.map((s) => [JSON.stringify([s.entryId, s.quote]), s]),
	);
	if (unique.size > ENGINE_SOURCES_MAX)
		throw new Error("record source limit exceeded");
	return [...unique.values()].sort((a, b) =>
		a.entryId < b.entryId
			? -1
			: a.entryId > b.entryId
				? 1
				: a.quote < b.quote
					? -1
					: a.quote > b.quote
						? 1
						: 0,
	);
}
export function deriveRecord(
	agentId: string,
	candidate: Observation,
	old: EngineRecord | undefined,
	revision: number,
	now: number,
	lookup: LookupEntry,
): EngineRecord {
	const same = old !== undefined && sameValue(old, candidate);
	const sources = mergeSources([
		...(same ? old.sources : []),
		...candidate.sources,
	]);
	const userSourceIds = [
		...new Set(
			sources
				.filter((s) => lookup(s.entryId)?.role === "user")
				.map((s) => s.entryId),
		),
	];
	const distinct = userSourceIds.length;
	const support =
		candidate.evidence === "explicit" || distinct >= 2
			? "supported"
			: "provisional";
	if (candidate.status === "resolved" && support !== "supported")
		throw new Error("concern resolution needs supported evidence");
	const hasNewEntry =
		!same ||
		candidate.sources.some(
			(s) => !old.sources.some((previous) => previous.entryId === s.entryId),
		);
	const sourceTimes = candidate.sources
		.map((s) => Date.parse(lookup(s.entryId)?.timestamp ?? ""))
		.filter((t) => Number.isFinite(t) && t >= 0 && t <= now);
	const witnessedAt = sourceTimes.length ? Math.max(...sourceTimes) : now;
	const validFrom = same ? old.validFrom : witnessedAt;
	return {
		...candidate,
		sources,
		userSourceIds,
		id: recordId(agentId, candidate),
		agentId,
		status: candidate.status ?? "active",
		support,
		revision,
		generation: old ? old.generation + (same ? 0 : 1) : 0,
		createdAt: old?.createdAt ?? now,
		updatedAt: hasNewEntry ? now : old.updatedAt,
		validFrom,
		expiresAt:
			candidate.kind === "mood"
				? hasNewEntry
					? witnessedAt + ENGINE_MOOD_TTL_MS
					: old.expiresAt
				: null,
		invalidatedAt: candidate.status === "retracted" ? now : null,
	};
}
