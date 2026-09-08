import type {
	ConversationStore,
	PreferenceProposal,
} from "../../../lina-core/src/agents/conversation.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { ReflectionInput } from "../../../lina-core/src/agents/types.ts";
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
	journalSources,
	requireEpisodeProofs,
} from "../context/companion-provenance.ts";
import type { MemoryBridge } from "../context/memory.ts";
import type { ContextServices } from "../context/port.ts";

/** One event-triggered reflection after a completed conversation turn; no wakeups. */
export class PersonaReflection {
	private running: Promise<void> | undefined;
	private readonly controller = new AbortController();
	private lastSeen: string | undefined;
	private error = "";
	constructor(
		private readonly options: {
			agents: AgentStore;
			conversations?: ConversationStore;
			agentId: string;
			journal: DurableStore;
			services: ContextServices;
			memory: Pick<MemoryBridge, "recall"> & {
				recallSourceProofs?: (text: string) => SourceProof[] | undefined;
			};
			preferencesOnly?: boolean;
		},
	) {
		// Do not backfill historical reflection on startup. Failed turns are not
		// retried automatically; the next completed conversation can reflect again.
		this.lastSeen = options.journal
			.requests()
			.find((r) => r.status === "settled")?.id;
	}
	status() {
		return { busy: !!this.running, error: this.error };
	}
	settled(): void {
		if (this.running || this.controller.signal.aborted) return;
		const { agents, agentId, journal, services, memory } = this.options;
		const request = journal.requests().find((r) => r.status === "settled");
		if (!request?.entryId || request.id === this.lastSeen || !services.reflect)
			return;
		const reflect = services.reflect;
		if (!reflect) return;
		const profile = agents.get(agentId);
		if (
			!profile ||
			(profile.evolution === "manual" && !this.options.conversations)
		)
			return;
		const source = journal.sourceEntry(request.entryId);
		if (source?.role !== "user" || !isOrdinarySource(source)) {
			this.lastSeen = request.id;
			return;
		}
		const lookup = (id: string) => journal.sourceEntry(id);
		const learned = agents.modelDynamics(agentId, lookup);
		const dynamics = learned.dynamics;
		if (dynamics.lastRequestId === request.id) {
			this.lastSeen = request.id;
			return;
		}
		const acceptedRequest = request;
		const revision = profile.revision;
		const preferenceRevision =
			this.options.conversations?.getPreferences(agentId).revision;
		this.error = "";
		this.running = (async () => {
			const episode = episodeProofs(journal, source.entryId);
			const recall = await memory.recall(source.text, this.controller.signal);
			requireEpisodeProofs(journal, source.entryId, episode);
			const recallProofs = recall
				? memory.recallSourceProofs?.(recall)
				: undefined;
			const qualifiedRecall = recallProofs?.length ? recall : "";
			// Filter before the history budget; each selected episode remains indivisible.
			const history = [...journalSources(journal)]
				.filter((entry) => entry.role === "user" && isOrdinarySource(entry))
				.flatMap((entry) => {
					try {
						return [
							{ entry, sourceProofs: episodeProofs(journal, entry.entryId) },
						];
					} catch {
						return [];
					}
				})
				.slice(-12);
			const preferences = this.options.conversations?.modelPreferences(
				agentId,
				lookup,
			);
			const proofs = mergeProofs(
				episode,
				learned.sourceProofs,
				preferences?.sourceProofs,
				...(qualifiedRecall ? [recallProofs] : []),
				...history.map((item) => item.sourceProofs),
			);
			requireCurrentProofs(proofs, lookup);
			const payload = {
				profile: {
					name: profile.name,
					role: profile.role,
					personality: profile.personality,
					voice: profile.voice,
					interests: profile.interests,
				},
				dynamics,
				userCommunicationPreferences: preferences?.items ?? [],
				allowCharacterGrowth:
					!this.options.preferencesOnly && profile.evolution === "adaptive",
				provisionalCharacterGrowth: learned.pendingGrowth,
				sourceEntryId: source.entryId,
				userMessage: source.text.slice(0, 6000),
				recentConversation: history.map(({ entry: e }) => ({
					id: e.entryId,
					role: e.role,
					text: e.text.slice(0, 2000),
				})),
				honchoReference: qualifiedRecall,
			};
			const validatePrompt = () => {
				this.controller.signal.throwIfAborted();
				requireCurrentProofs(proofs, lookup);
				for (const proof of proofs)
					if (lookup(proof.entryId)?.role === "user")
						requireEpisodeProofs(journal, proof.entryId, proofs);
				if (
					qualifiedRecall &&
					!memory.recallSourceProofs?.(qualifiedRecall)?.length
				)
					throw Error("stale reflection recall provenance");
			};
			validatePrompt();
			const raw = await reflect(
				JSON.stringify(payload),
				this.controller.signal,
				validatePrompt,
			);
			validatePrompt();
			const value: unknown = JSON.parse(
				raw
					.trim()
					.replace(/^```(?:json)?\s*/, "")
					.replace(/\s*```$/, ""),
			);
			if (!value || typeof value !== "object" || Array.isArray(value))
				throw Error("Invalid reflection");
			const candidate = value as Record<string, unknown>;
			const allowed = new Set([
				"mood",
				"interests",
				"preferences",
				"relationship",
				"communicationPreferences",
			]);
			if (Object.keys(candidate).some((k) => !allowed.has(k)))
				throw Error("Unexpected reflection field");
			const { communicationPreferences, ...growth } = candidate;
			if (this.options.conversations) {
				try {
					this.options.conversations.observePreferences(
						agentId,
						acceptedRequest.id,
						source.entryId,
						source.text,
						(communicationPreferences ?? []) as PreferenceProposal[],
						(entryId) => {
							const entry = journal.sourceEntry(entryId);
							return isOrdinarySource(entry) &&
								entry?.role === "user" &&
								entryId === source.entryId
								? { role: "user", entryId: entry.entryId, text: entry.text }
								: undefined;
						},
						preferenceRevision,
						{ sourceProofs: proofs, lookup },
					);
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== "stale preferences revision"
					)
						throw error;
					// A newer user reset wins; independent character growth remains valid.
				}
			}
			if (!this.options.preferencesOnly)
				agents.applyReflection(
					agentId,
					{
						...growth,
						profileRevision: revision,
						dynamicsRevision: dynamics.revision,
						requestId: acceptedRequest.id,
						sourceEntryIds: [source.entryId],
					} as ReflectionInput,
					(id) =>
						isOrdinarySource(lookup(id)) &&
						lookup(id)?.role === "user" &&
						id === source.entryId,
					{ sourceProofs: proofs, lookup },
				);
			this.lastSeen = acceptedRequest.id;
		})()
			.catch(() => {
				this.error = "대화에서 배운 내용을 정리하지 못했습니다.";
				this.lastSeen = acceptedRequest.id;
			})
			.finally(() => {
				this.running = undefined;
				this.settled();
			});
	}
	async drain(): Promise<void> {
		while (this.running) await this.running;
	}
	async close(): Promise<void> {
		this.controller.abort();
		await this.drain();
	}
}
