import type {
	ConversationStore,
	PreferenceProposal,
} from "../../../lina-core/src/agents/conversation.ts";
import type { EntryInput } from "../../../lina-core/src/protocol.ts";
import {
	isOrdinarySource,
	type SourceProof,
} from "../../../lina-core/src/source-policy.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import {
	mergeProofs,
	requireCurrentProofs,
} from "../../../lina-memory/src/engine/provenance.ts";
import {
	episodeProofs,
	requireEpisodeProofs,
} from "../context/companion-provenance.ts";

/** Native episode queue owns retries; ConversationStore owns preference authority. */
export function nativePreferences(
	store: ConversationStore,
	agentId: string,
	journal: DurableStore,
	reflect: (
		text: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
	) => Promise<string>,
) {
	const lookup = (id: string) => journal.sourceEntry(id);
	const requestFor = (id: string) => {
		const r = journal.requestByEntry(id);
		if (r?.status !== "settled" || !isOrdinarySource(lookup(id)))
			throw Error("Preference source is not settled");
		return r;
	};
	return {
		resetRevision: () => store.preferenceResetAt(agentId),
		hasReceipt: (id: string) => {
			if (!isOrdinarySource(lookup(id))) return false;
			return store.hasPreferenceReceipt(agentId, requestFor(id).id, lookup);
		},
		receiptWithheld: (id: string) => {
			const request = journal.requestByEntry(id);
			return (
				!!request &&
				store.hasPreferenceReceipt(agentId, request.id) &&
				!store.hasPreferenceReceipt(agentId, request.id, lookup)
			);
		},
		async process(
			source: EntryInput,
			resetBaseline: number,
			signal: AbortSignal,
			sourceProofs?: SourceProof[],
		): Promise<boolean> {
			const request = requestFor(source.entryId);
			const episode = episodeProofs(journal, source.entryId);
			const preferences = store.modelPreferences(agentId, lookup);
			const proofs = mergeProofs(
				episode,
				sourceProofs,
				preferences.sourceProofs,
			);
			const validatePrompt = () => {
				signal.throwIfAborted();
				requireCurrentProofs(proofs, lookup);
				// A new member can invalidate an episode without changing any saved proof.
				for (const proof of proofs)
					if (lookup(proof.entryId)?.role === "user")
						requireEpisodeProofs(journal, proof.entryId, proofs);
			};
			validatePrompt();
			if (lookup(source.entryId)?.text !== source.text)
				throw Error("preference source mismatch");
			if (store.hasPreferenceReceipt(agentId, request.id, lookup)) return false;
			if (store.hasPreferenceReceipt(agentId, request.id))
				throw Error("ineligible or stale engine source provenance");
			const reset = () =>
				store.preferenceResetAt(agentId) !== resetBaseline ||
				Date.parse(request.createdAt) <= store.preferenceResetAt(agentId);
			let proposals: PreferenceProposal[] = [];
			if (!reset()) {
				if (source.text.length > 32000)
					throw Error("complete_preference_source_exceeds_budget");
				validatePrompt();
				const raw = await reflect(
					JSON.stringify({
						preferencesOnly: true,
						allowCharacterGrowth: false,
						sourceEntryId: source.entryId,
						userMessage: source.text,
						userCommunicationPreferences: preferences.items,
					}),
					signal,
					validatePrompt,
				);
				validatePrompt();
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
			validatePrompt();
			// Synchronous commit after reset check: sibling preference writes are allowed,
			// but an actual user reset retires this episode with an empty receipt.
			if (reset()) proposals = [];
			if (!Array.isArray(proposals))
				throw Error("invalid_preference_proposals");
			const current = store.modelPreferences(agentId, lookup);
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
					const e = lookup(id);
					return isOrdinarySource(e) &&
						e?.role === "user" &&
						id === source.entryId
						? { role: "user", entryId: id, text: e.text }
						: undefined;
				},
				store.getPreferences(agentId).revision,
				{ sourceProofs: proofs, lookup },
			);
			return proposals.length > 0;
		},
	};
}
