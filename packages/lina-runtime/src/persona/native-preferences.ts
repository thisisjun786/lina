import type {
	ConversationStore,
	PreferenceProposal,
} from "../../../lina-core/src/agents/conversation.ts";
import type { EntryInput } from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";

/** Native episode queue owns retries; ConversationStore owns preference authority. */
export function nativePreferences(
	store: ConversationStore,
	agentId: string,
	journal: DurableStore,
	reflect: (text: string, signal: AbortSignal) => Promise<string>,
) {
	const requestFor = (id: string) => {
		const r = journal.requestByEntry(id);
		if (!r || r.status !== "settled")
			throw Error("Preference source is not settled");
		return r;
	};
	return {
		resetRevision: () => store.preferenceResetAt(agentId),
		hasReceipt: (id: string) =>
			store.hasPreferenceReceipt(agentId, requestFor(id).id),
		async process(
			source: EntryInput,
			resetBaseline: number,
			signal: AbortSignal,
		): Promise<boolean> {
			const request = requestFor(source.entryId);
			if (store.hasPreferenceReceipt(agentId, request.id)) return false;
			const reset = () =>
				store.preferenceResetAt(agentId) !== resetBaseline ||
				Date.parse(request.createdAt) <= store.preferenceResetAt(agentId);
			let proposals: PreferenceProposal[] = [];
			if (!reset()) {
				if (source.text.length > 32000)
					throw Error("complete_preference_source_exceeds_budget");
				const raw = await reflect(
					JSON.stringify({
						preferencesOnly: true,
						allowCharacterGrowth: false,
						sourceEntryId: source.entryId,
						userMessage: source.text,
						userCommunicationPreferences: store.getPreferences(agentId).items,
					}),
					signal,
				);
				signal.throwIfAborted();
				const parsed: unknown = JSON.parse(
					raw
						.trim()
						.replace(/^```(?:json)?\s*/, "")
						.replace(/\s*```$/, ""),
				);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					throw Error("invalid_preference_json");
				proposals =
					(parsed as { communicationPreferences?: PreferenceProposal[] })
						.communicationPreferences ?? [];
			}
			signal.throwIfAborted();
			// Synchronous commit after reset check: sibling preference writes are allowed,
			// but an actual user reset retires this episode with an empty receipt.
			if (reset()) proposals = [];
			if (!Array.isArray(proposals))
				throw Error("invalid_preference_proposals");
			const current = store.getPreferences(agentId);
			const sourceSeq = journal.entrySequence(source.entryId) ?? 0;
			proposals = proposals.filter((proposal) => {
				const previous = current.items.find(
					(p) => p.dimension === proposal?.dimension,
				);
				return (
					!previous ||
					(journal.entrySequence(previous.sourceEntryId) ?? 0) <= sourceSeq
				);
			});
			store.observePreferences(
				agentId,
				request.id,
				source.entryId,
				source.text,
				proposals,
				(id) => {
					const e = journal.entry(id);
					return e?.role === "user" && id === source.entryId
						? { role: "user", entryId: id, text: e.text }
						: undefined;
				},
				store.getPreferences(agentId).revision,
			);
			return proposals.length > 0;
		},
	};
}
