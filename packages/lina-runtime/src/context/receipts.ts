import { isDeepStrictEqual } from "node:util";
import type { ContextStore } from "../../../lina-core/src/context/index.ts";
import { decodeProofs } from "../../../lina-core/src/context/validation.ts";
import type { SourceProof } from "../../../lina-core/src/source-policy.ts";
import { nativeSummary } from "./tree.ts";

export type SummaryReceipt = {
	linaContext: {
		version: 2;
		id: string;
		expectedActiveId: string | null;
		sourceProofs: SourceProof[];
	};
};
export type CompactionCandidate = {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details: SummaryReceipt;
};
type Fields = Record<string, unknown>;
function record(raw: unknown): Fields | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw)
		? (raw as Fields)
		: undefined;
}
export function activateReceipt(store: ContextStore, raw: unknown): boolean {
	const entry = record(raw),
		details = record(entry?.["details"]),
		receipt = record(details?.["linaContext"]);
	if (!receipt) return false;
	const id = receipt["id"],
		expected = receipt["expectedActiveId"];
	if (
		entry?.["type"] !== "compaction" ||
		typeof entry["id"] !== "string" ||
		typeof entry["firstKeptEntryId"] !== "string" ||
		receipt["version"] !== 2 ||
		typeof id !== "string" ||
		!(expected === null || typeof expected === "string")
	)
		throw new Error("Invalid context receipt");
	const node = store.get(id);
	if (
		!node ||
		entry["summary"] !== nativeSummary(node) ||
		!isDeepStrictEqual(decodeProofs(receipt["sourceProofs"]), node.sourceProofs)
	)
		throw new Error("Context receipt does not match staged summary");
	store.activate({
		id,
		nativeEntryId: entry["id"],
		firstKeptEntryId: entry["firstKeptEntryId"],
		expectedActiveId: expected,
	});
	return true;
}

export function restoreReceipts(
	store: ContextStore,
	entries: readonly unknown[],
): boolean {
	const active = store.active();
	let start = 0;
	let synchronized = active === null;
	if (active) {
		const position = entries.findIndex(
			(raw) => record(raw)?.["id"] === active.nativeEntryId,
		);
		if (position >= 0) {
			try {
				synchronized = activateReceipt(store, entries[position]);
			} catch {
				synchronized = false;
			}
			start = position + 1;
		}
	}
	for (const raw of entries.slice(start)) {
		if (record(raw)?.["type"] !== "compaction") continue;
		// Missing local summaries do not make the surviving native originals unusable.
		try {
			synchronized = activateReceipt(store, raw);
		} catch {
			synchronized = false;
		}
	}
	return synchronized;
}
