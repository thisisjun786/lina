import type {
	ContextStore,
	SourceRef,
} from "../../../lina-core/src/context/index.ts";
import type { ExternalContext } from "./external.ts";
import { contextInjection } from "./injection.ts";
import type { CompactSourceEvent } from "./native.ts";
import type { ContextServices } from "./port.ts";
import {
	activateReceipt,
	type CompactionCandidate,
	restoreReceipts,
} from "./receipts.ts";
import { createSummaryTree, nativeSummary } from "./tree.ts";

type Options = {
	store: ContextStore;
	busy: () => boolean;
	compact: () => Promise<unknown>;
	external?: ExternalContext;
	nativeTokens?: () => number | null;
};
type OwnedRequest = {
	id: string;
	candidate?: CompactionCandidate;
	controller: AbortController;
	dispose: () => void;
};
export type CompactionStatus =
	| "idle"
	| "summarizing"
	| "accepted"
	| "rejected"
	| "failed";
export class ContextCoordinator {
	private services: ContextServices | undefined;
	private readonly listeners = new Set<() => void>();
	private request: OwnedRequest | undefined;
	private manualBusy = false;
	private closed = false;
	private degraded = false;
	private status: CompactionStatus = "idle";
	private recall = "";
	private lastInjection = { text: "", tokens: 0, omitted: false };
	constructor(private readonly options: Options) {}
	configure(services: ContextServices): void {
		this.services = services;
	}
	get isBusy(): boolean {
		return this.manualBusy || this.request !== undefined;
	}
	state() {
		const active = this.degraded ? null : this.options.store.active();
		return {
			status: this.status,
			activeId: active?.id ?? null,
			recoveryNeeded: this.degraded,
			sourceCount: active
				? (this.options.store.get(active.id)?.sources.length ?? 0)
				: 0,
			injectionTokens: this.lastInjection.tokens,
			injectionOmitted: this.lastInjection.omitted,
		};
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	changed(): void {
		if (!this.closed) for (const listener of this.listeners) listener();
	}
	setRecall(text: string): void {
		this.recall = text.slice(0, 4096);
		this.changed();
	}
	injection(messages: readonly unknown[]): string {
		if (!this.services || this.closed) return "";
		const used = this.options.nativeTokens?.() ?? 0;
		const services = this.options.external
			? {
					...this.services,
					contextWindow:
						this.services.contextWindow -
						Math.max(0, used - this.services.systemTokens),
				}
			: this.services;
		this.lastInjection = contextInjection(
			this.options.store.working(),
			this.recall,
			messages,
			services,
		);
		const external = this.options.external?.injection();
		if (external) {
			const text = [external, this.lastInjection.text]
				.filter(Boolean)
				.join("\n\n");
			const tokens = this.services.estimateText(text);
			const available =
				services.contextWindow -
				this.services.reserveTokens -
				this.services.systemTokens -
				this.services.estimateMessages(messages);
			if (tokens <= available)
				this.lastInjection = { ...this.lastInjection, text, tokens };
			else this.lastInjection.omitted = true;
		}
		this.changed();
		return this.lastInjection.text;
	}
	async before(
		event: CompactSourceEvent,
		signal: AbortSignal,
	): Promise<CompactionCandidate> {
		if (!this.services || this.closed || this.request)
			throw new Error("Context coordinator is unavailable or busy");
		const request: OwnedRequest = {
			id: event.requestId,
			controller: new AbortController(),
			dispose: () => {},
		};
		this.request = request;
		const aborted = () => {
			if (this.request === request) this.failed();
		};
		signal.addEventListener("abort", aborted, { once: true });
		request.dispose = () => signal.removeEventListener("abort", aborted);
		const ownedSignal = AbortSignal.any([signal, request.controller.signal]);
		this.status = "summarizing";
		this.changed();
		try {
			ownedSignal.throwIfAborted();
			const prepared = this.services.prepare(event),
				active = this.options.store.active();
			const sources: SourceRef[] = [];
			if (prepared.previousCompactionId) {
				if (active?.nativeEntryId === prepared.previousCompactionId)
					sources.push({ kind: "summary", id: active.id });
				else {
					this.degraded = true;
					// Legacy or divergent summaries rebuild links from surviving native originals.
					for (const raw of event.branchEntries) {
						if (
							!raw ||
							typeof raw !== "object" ||
							!("id" in raw) ||
							typeof raw.id !== "string"
						)
							continue;
						if (raw.id === prepared.firstKeptEntryId) break;
						if (!prepared.sourceEntryIds.includes(raw.id))
							sources.push({ kind: "entry", id: raw.id });
					}
				}
			}
			sources.push(
				...prepared.sourceEntryIds.map((id) => ({
					kind: "entry" as const,
					id,
				})),
			);
			const root = await createSummaryTree(
				sources,
				this.options.store,
				this.services.summarize,
				ownedSignal,
				prepared.fits,
				this.services.summaryCacheKey?.(),
			);
			ownedSignal.throwIfAborted();
			if (this.request !== request || this.closed)
				throw new Error("Stale compaction request");
			const candidate: CompactionCandidate = {
				summary: nativeSummary(root),
				firstKeptEntryId: prepared.firstKeptEntryId,
				tokensBefore: prepared.tokensBefore,
				details: {
					linaContext: {
						version: 1,
						id: root.id,
						expectedActiveId: active?.id ?? null,
					},
				},
			};
			request.candidate = candidate;
			return candidate;
		} catch (error) {
			if (this.request === request) this.failed();
			throw error;
		}
	}
	accepted(requestId: string, raw: unknown): void {
		if (this.closed) return;
		if (this.request?.id !== requestId || !this.request.candidate)
			throw new Error("Unowned context receipt");
		const candidate = this.request.candidate;
		if (
			!raw ||
			typeof raw !== "object" ||
			!("summary" in raw) ||
			raw.summary !== candidate.summary ||
			!("firstKeptEntryId" in raw) ||
			raw.firstKeptEntryId !== candidate.firstKeptEntryId
		)
			throw new Error("Native receipt differs from the requested compaction");
		this.degraded = true;
		if (!activateReceipt(this.options.store, raw))
			throw new Error("Native context receipt is missing");
		this.retire();
		this.degraded = false;
		this.status = "accepted";
		this.changed();
	}
	rejected(requestId: string): void {
		if (this.request?.id !== requestId || this.closed) return;
		this.retire();
		this.status = "rejected";
		this.changed();
	}
	failed(): void {
		if (this.closed) return;
		this.retire();
		this.status = "failed";
		this.changed();
	}
	restore(entries: readonly unknown[]): void {
		this.retire();
		this.degraded = this.options.external
			? !this.options.external.valid()
			: !restoreReceipts(this.options.store, entries);
		this.status = this.degraded
			? "failed"
			: this.options.store.active()
				? "accepted"
				: "idle";
		this.changed();
	}
	async refreshExternal(signal: AbortSignal): Promise<void> {
		if (!this.options.external) return;
		signal.throwIfAborted();
		try {
			await this.options.external.refresh(
				AbortSignal.any([signal, AbortSignal.timeout(15000)]),
			);
			this.restore([]);
		} catch {
			signal.throwIfAborted();
			// Failed auxiliary work cannot prevent the user from reaching the assistant.
			// ExternalContext still injects the last valid source-linked checkpoint.
			this.degraded = true;
			this.failed();
		}
	}
	settled(): void {
		if (this.request) this.failed();
	}
	private retire(): void {
		const request = this.request;
		this.request = undefined;
		request?.dispose();
		request?.controller.abort();
	}
	async manual(): Promise<void> {
		if (this.closed || this.isBusy || this.options.busy())
			throw new Error("Context is busy");
		this.manualBusy = true;
		this.status = "summarizing";
		this.changed();
		try {
			if (this.options.external)
				await this.options.external.refresh(AbortSignal.timeout(120000), true);
			await this.options.compact();
			if (this.options.external) this.restore([]);
			if (this.status === "summarizing")
				throw new Error("Native compaction did not produce a confirmed result");
		} catch (error) {
			this.failed();
			throw error;
		} finally {
			this.manualBusy = false;
			this.changed();
		}
	}
	close(): void {
		this.closed = true;
		this.options.external?.close();
		this.retire();
		this.listeners.clear();
	}
}
