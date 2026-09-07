import { isDeepStrictEqual } from "node:util";

export type CompactSourceEvent = {
	requestId: string;
	reason: string;
	branchEntries: readonly unknown[];
	preparation: {
		firstKeptEntryId: string;
		tokensBefore: number;
		previousSummary?: string;
		messagesToSummarize: readonly unknown[];
		turnPrefixMessages: readonly unknown[];
		isSplitTurn: boolean;
	};
};
export type PreparedContext = {
	requestId: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	sourceEntryIds: string[];
	previousCompactionId: string | null;
	previousSummary: string | null;
	fits: (summary: string) => boolean;
};

type Entry = {
	id: string;
	type: string;
	summary?: string;
	firstKeptEntryId?: string;
};
function entry(raw: unknown): Entry {
	if (
		!raw ||
		typeof raw !== "object" ||
		!("id" in raw) ||
		typeof raw.id !== "string" ||
		!("type" in raw) ||
		typeof raw.type !== "string"
	)
		throw new Error("Invalid native context entry");
	return raw as Entry;
}

/** Validate the selected source interval against native preparation, including split turns. */
export function prepareContextInput(
	event: CompactSourceEvent,
	toMessages: (raw: unknown) => readonly unknown[],
	fits: (summary: string) => boolean,
): PreparedContext {
	if (event.reason === "branch")
		throw new Error("Lina does not compact a branch");
	const entries = event.branchEntries.map(entry),
		prep = event.preparation;
	const cut = entries.findIndex((value) => value.id === prep.firstKeptEntryId);
	if (cut < 0) throw new Error("Native cut point is missing");
	const previous = entries.findLast((value) => value.type === "compaction");
	if ((previous?.summary ?? null) !== (prep.previousSummary ?? null))
		throw new Error("Previous native summary does not match preparation");
	const boundary = previous
		? entries.findIndex((value) => value.id === previous.firstKeptEntryId)
		: 0;
	if (boundary < 0 || boundary > cut)
		throw new Error("Invalid previous native cut");
	const selected: unknown[] = [],
		sourceEntryIds: string[] = [];
	for (let index = boundary; index < cut; index++) {
		const value = entries[index];
		if (!value || value.type === "compaction") continue;
		const message = toMessages(event.branchEntries[index])[0];
		if (message !== undefined) {
			selected.push(message);
			sourceEntryIds.push(value.id);
		}
	}
	const expected = [
		...prep.messagesToSummarize,
		...(prep.isSplitTurn ? prep.turnPrefixMessages : []),
	];
	if (!isDeepStrictEqual(selected, expected))
		throw new Error("Native source projection changed");
	return {
		requestId: event.requestId,
		firstKeptEntryId: prep.firstKeptEntryId,
		tokensBefore: prep.tokensBefore,
		sourceEntryIds,
		previousCompactionId: previous?.id ?? null,
		previousSummary: previous?.summary ?? null,
		fits,
	};
}
