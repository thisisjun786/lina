import {
	captureSourceProofs,
	isOrdinarySource,
	type SourceEntry,
	type SourceProof,
	sourceProofsCurrent,
} from "../../../lina-core/src/source-policy.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";

/** Only a provenance verdict can permanently withhold work; lookup failures retry. */
export class SourceEpisodeError extends Error {
	constructor() {
		super("ineligible or stale engine source provenance");
	}
}

/** Read associations from the journal owner; never infer an episode from raw/text. */
export function episodeSourceIds(
	journal: DurableStore,
	userId: string,
): string[] {
	const episode = journal.sourceEpisode(userId);
	if (
		!episode.some((entry) => entry.entryId === userId && entry.role === "user")
	)
		throw new SourceEpisodeError();
	return [
		userId,
		...episode
			.filter((entry) => entry.entryId !== userId)
			.map((entry) => entry.entryId),
	];
}
/** Re-resolve membership without replacing any captured revision/digest. */
export function requireEpisodeProofs(
	journal: DurableStore,
	userId: string,
	proofs: SourceProof[],
): string[] {
	const source = journal.sourceEntry(userId),
		ids = episodeSourceIds(journal, userId);
	if (
		source?.role !== "user" ||
		!isOrdinarySource(source) ||
		!sourceProofsCurrent(proofs, (id) => journal.sourceEntry(id)) ||
		ids.some(
			(id) =>
				!proofs.some((p) => p.entryId === id) ||
				journal.sourceEntry(id)?.sourcePolicy?.requestId !==
					source.sourcePolicy?.requestId,
		)
	)
		throw new SourceEpisodeError();
	return ids;
}
export function episodeProofs(journal: DurableStore, userId: string) {
	const proofs = captureSourceProofs(episodeSourceIds(journal, userId), (id) =>
		journal.sourceEntry(id),
	);
	requireEpisodeProofs(journal, userId, proofs);
	return proofs;
}
export function* journalSources(journal: DurableStore): Generator<SourceEntry> {
	let after = 0;
	for (;;) {
		const page = journal.scanAfter(after, 100);
		for (const row of page) {
			after = row.seq;
			const entry = journal.sourceEntry(row.entry.entryId);
			if (entry) yield entry;
		}
		if (page.length < 100) return;
	}
}
