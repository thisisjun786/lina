import type { EntryInput } from "../../../lina-core/src/protocol.ts";
import { isOrdinarySource } from "../../../lina-core/src/source-policy.ts";
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
		const source = journal.sourceEntry(row.entry.entryId);
		// Accepted requests may still gain disclosures/exposures; wait for settlement.
		if (
			source?.requestStatus === "accepted" ||
			source?.requestStatus === "queued" ||
			(row.entry.role === "user" &&
				(row.requestStatus === "accepted" || row.requestStatus === "queued"))
		)
			break;
		state.eligibleUser = isOrdinarySource(source);
		if (
			outbox.policyScope &&
			isOrdinarySource(source) &&
			source?.text.trim() &&
			(source.role === "user" ||
				(source.role === "assistant" && finalAssistant(row.entry)))
		)
			outbox.enqueue(source.entryId, source.role, source.text);
		state.after = row.seq;
		outbox.setScanState(state);
		visited++;
	}
	return visited;
}
