import type { EntryInput } from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import type { HonchoOutbox } from "../../../lina-memory/src/honcho/index.ts";

function finalAssistant(entry: EntryInput): boolean {
	const raw = entry.raw as {
		type?: unknown;
		message?: { role?: unknown; stopReason?: unknown; content?: unknown };
	} | null;
	return (
		raw?.type === "message" &&
		raw.message?.role === "assistant" &&
		raw.message.stopReason === "stop"
	);
}

/** The journal commits first; repeated enqueue after a crash is content-idempotent. */
export function scanCaptures(
	journal: DurableStore,
	outbox: HonchoOutbox,
	limit = 100,
): number {
	const state = outbox.scanState();
	const page = journal.scanAfter(state.after, limit);
	let visited = 0;
	for (const row of page) {
		if (row.entry.role === "user") {
			if (row.requestStatus === "accepted" || row.requestStatus === "queued")
				break;
			state.eligibleUser = row.requestStatus === "settled";
		}
		if (
			state.eligibleUser &&
			row.entry.text.trim() &&
			(row.entry.role === "user" ||
				(row.entry.role === "assistant" && finalAssistant(row.entry)))
		)
			outbox.enqueue(row.entry.entryId, row.entry.role, row.entry.text);
		state.after = row.seq;
		outbox.setScanState(state);
		visited++;
	}
	return visited;
}
