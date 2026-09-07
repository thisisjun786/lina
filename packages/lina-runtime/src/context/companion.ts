import type {
	BotBinding,
	EntryInput,
} from "../../../lina-core/src/protocol.ts";
import type { DurableStore } from "../../../lina-core/src/store.ts";
import {
	buildObservationPrompt,
	renderMemoryReference,
} from "../../../lina-memory/src/engine/prompt.ts";
import { EngineStore } from "../../../lina-memory/src/engine/store.ts";
import { parseObservations } from "../../../lina-memory/src/engine/validation.ts";
import { ModelRequestError } from "../models/errors.ts";
import type { nativePreferences } from "../persona/native-preferences.ts";
import {
	type CompanionJob,
	CompanionQueue,
	type CompanionScan,
} from "./companion-queue.ts";
import type { MemorySnapshot } from "./memory.ts";

type Observer = (input: string, signal: AbortSignal) => Promise<string>;
type Schedule = (callback: () => void, delay: number) => () => void;
const SCAN_BATCH = 100;
const OBSERVE_TIMEOUT_MS = 60_000;
const defaultSchedule: Schedule = (callback, delay) => {
	const timer = setTimeout(callback, delay);
	timer.unref();
	return () => clearTimeout(timer);
};

function finalAssistant(entry: EntryInput): boolean {
	const raw = entry.raw as {
		type?: unknown;
		message?: { role?: unknown; stopReason?: unknown };
	} | null;
	return (
		entry.role === "assistant" &&
		raw?.type === "message" &&
		raw.message?.role === "assistant" &&
		raw.message.stopReason === "stop"
	);
}

export class CompanionMemory {
	readonly mind: EngineStore;
	private readonly queue: CompanionQueue;
	private readonly controller = new AbortController();
	private readonly schedule: Schedule;
	private cancelWake: (() => void) | undefined;
	private observer: Observer | undefined;
	private preferences: ReturnType<typeof nativePreferences> | undefined;
	private inflight: Promise<void> | undefined;
	private rerun = false;
	private closed = false;
	private closing: Promise<void> | undefined;
	private error: string | null = null;
	private recallText = "";
	constructor(
		private readonly options: {
			path: string;
			binding: BotBinding;
			journal: DurableStore;
			onChange?: () => void;
			now?: () => number;
			schedule?: Schedule;
			allowCharacterGrowth?: () => boolean;
			characterReference?: () => string;
		},
	) {
		this.schedule = options.schedule ?? defaultSchedule;
		// session-app holds the app lease before construction and until close completes.
		this.queue = new CompanionQueue(
			`${options.path}.queue`,
			options.binding,
			options,
		);
		try {
			this.mind = new EngineStore(options.path, options.binding, {
				lookup: (id) => options.journal.entry(id),
				sourceSequence: (id) => options.journal.entrySequence(id),
				...(options.now ? { now: options.now } : {}),
			});
		} catch (e) {
			this.queue.close();
			throw e;
		}
	}
	configure(
		observer: Observer,
		preferences?: ReturnType<typeof nativePreferences>,
	): void {
		this.observer = observer;
		this.preferences = preferences;
	}
	status(): MemorySnapshot {
		return {
			...this.queue.counts(),
			service: !this.observer
				? "disabled"
				: this.error || this.queue.latestError()
					? "unavailable"
					: "ready",
			freshness: "unknown",
			recallText: this.recallText,
		};
	}
	detail() {
		return {
			state: this.mind.snapshot(),
			processing: {
				...this.status(),
				...this.queue.processing(),
				storedRecords: this.mind.recordCount(),
				error: this.error ?? this.queue.latestError(),
				historicalError: this.queue.error(),
			},
		};
	}
	async recall(query: string, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (this.closed) return "";
		const state = this.mind.state();
		const terms = [
			query.slice(0, 2000),
			...(query.match(/[\p{L}\p{N}._-]{2,}/gu) ?? []).slice(0, 8),
		];
		const matches = terms.flatMap((term) =>
			this.mind.recall(term, { limit: 6 }),
		);
		const records = [
			...new Map(
				[
					...matches,
					...state.records
						.filter(
							(r) =>
								r.subject === "user" &&
								r.kind === "preference" &&
								r.support === "supported",
						)
						.slice(0, 4),
					...state.records.filter(
						(r) =>
							r.kind === "concern" || r.kind === "mood" || r.subject !== "user",
					),
				].map((r) => [r.id, r]),
			).values(),
		];
		this.recallText = renderMemoryReference({ ...state, records }, 4096);
		return this.recallText;
	}
	private complete(state: CompanionScan): void {
		if (!state.user) return;
		const job = {
			id: state.user,
			sources: [state.user, ...(state.assistant ? [state.assistant] : [])],
		};
		state.user = null;
		state.assistant = null;
		this.queue.checkpoint(state, job);
	}
	/** One page per turn; an open episode is durable even across pages/restarts. */
	private scan(): boolean {
		const state = this.queue.scanState();
		const page = this.options.journal.scanAfter(state.after, SCAN_BATCH);
		for (const row of page) {
			if (row.entry.role === "user") {
				this.complete(state);
				if (!row.requestStatus) {
					// Before the first app request, correlation may still arrive. Once
					// app requests exist, uncorrelated imported/probe entries are not
					// eligible memory and must not fence all later settled episodes.
					if (!this.options.journal.requests(1).length) {
						this.error = "Missing request settlement receipt; scan paused";
						return false;
					}
					state.user = null;
					state.assistant = null;
					state.after = row.seq;
					this.queue.checkpoint(state);
					continue;
				}
				if (row.requestStatus === "accepted" || row.requestStatus === "queued")
					return false;
				state.user = row.requestStatus === "settled" ? row.entry.entryId : null;
			} else if (state.user && finalAssistant(row.entry))
				state.assistant = row.entry.entryId;
			state.after = row.seq;
			this.queue.checkpoint(state);
		}
		if (page.length < SCAN_BATCH) this.complete(state);
		return page.length === SCAN_BATCH;
	}
	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.inflight) {
			this.rerun = true;
			return this.inflight;
		}
		this.cancelWake?.();
		this.cancelWake = undefined;
		// Defer the work so even an onChange callback sees the established inflight owner.
		this.inflight = Promise.resolve()
			.then(() => this.run())
			.finally(() => {
				this.inflight = undefined;
			});
		return this.inflight;
	}
	private async run(): Promise<void> {
		let more = false;
		this.rerun = false;
		this.error = null;
		try {
			const recovering = this.queue.reconcileReceipts(
				(id) =>
					this.mind.hasReceipt(id) &&
					(!this.preferences || this.preferences.hasReceipt(id)),
			);
			more = this.scan() || recovering;
			const observe = this.observer;
			if (observe)
				for (const job of this.queue.pending()) {
					if (this.closed) break;
					await this.process(job, observe);
				}
		} catch {
			this.error = "Companion scan or queue failed; progress preserved";
			this.changed();
			return;
		}
		if (!this.closed) {
			this.changed();
			const due = this.observer ? this.queue.nextDelay() : undefined;
			if (more || this.rerun || due !== undefined)
				this.cancelWake = this.schedule(
					() => {
						this.cancelWake = undefined;
						void this.refresh();
					},
					more || this.rerun ? 0 : (due ?? 0),
				);
		}
	}
	private async process(job: CompanionJob, observe: Observer): Promise<void> {
		if (
			this.mind.hasReceipt(job.id) &&
			(!this.preferences || this.preferences.hasReceipt(job.id))
		) {
			this.queue.finish(job.id, true);
			return;
		}
		if (!this.queue.start(job.id)) {
			this.queue.finish(job.id, false, "retry_attempts_exhausted");
			return;
		}
		this.changed();
		let stage = "source_validation_failed";
		try {
			const entries = job.sources.map((id) => {
				const entry = this.options.journal.entry(id);
				if (!entry) throw Error("Missing source");
				return entry;
			});
			if (
				entries[0]?.role !== "user" ||
				this.options.journal.requestByEntry(entries[0].entryId)?.status !==
					"settled"
			)
				throw Error("Source is not settled");
			const preferences = this.preferences;
			if (preferences && !preferences.hasReceipt(job.id)) {
				stage = "preference_failed";
				const source = entries[0];
				if (!source) throw Error("Missing user source");
				const baseline = this.queue.resetBaseline(
					job.id,
					preferences.resetRevision(),
				);
				const changed = await this.observe(
					async (_prompt, signal) =>
						String(await preferences.process(source, baseline, signal)),
					"",
				);
				if (changed === "true") this.queue.markChanged(job.id);
			}
			if (this.mind.hasReceipt(job.id)) {
				this.queue.finish(job.id, true, null, "unchanged");
				return;
			}
			const snapshot = this.mind.snapshot();
			stage = "complete_source_exceeds_prompt_budget";
			const character = this.options.characterReference?.() ?? "";
			const prompt =
				buildObservationPrompt(
					entries,
					snapshot,
					32000 - Math.min(4000, character.length),
				) +
				(character
					? `\nAuthored character reference (immutable, not lived evidence): ${character.slice(0, 4000)}`
					: "");
			stage = "observer_failed_or_timed_out";
			const feedback = this.queue.jobError(job.id);
			const raw = await this.observe(
				observe,
				prompt +
					(feedback
						? `\nPREVIOUS ATTEMPT REJECTED: ${feedback}. Fix this validation error. Use only SOURCE DATA entry IDs, one candidate per subject/kind/key, resolved only for concerns. A corrected value replaces the slot with ONE active candidate, never a separate retracted candidate for that same slot. Keep all justified independent candidates.`
						: ""),
			);
			this.controller.signal.throwIfAborted();
			stage = "invalid_observation_or_source_quote";
			const parsed: unknown = JSON.parse(
				raw
					.trim()
					.replace(/^```(?:json)?\s*/, "")
					.replace(/\s*```$/, ""),
			);
			const observations = parseObservations(
				Array.isArray(parsed)
					? parsed
					: (parsed as { observations?: unknown })?.observations,
			).filter(
				(o) =>
					o.subject === "user" ||
					this.options.allowCharacterGrowth?.() !== false,
			);
			const allowed = new Set(job.sources);
			if (
				observations.some((o) => o.sources.some((s) => !allowed.has(s.entryId)))
			)
				throw Error("Source outside observed episode");
			// Never rebase a generated delta. On revision conflict the next bounded attempt
			// observes a fresh snapshot; EngineStore's evidence fences still apply.
			stage = "apply_conflict_or_invalid_evidence";
			const applied = this.mind.apply(
				{
					requestId: job.id,
					expectedRevision: snapshot.revision,
					observations,
				},
				this.controller.signal,
			);
			this.queue.finish(
				job.id,
				true,
				null,
				JSON.stringify(applied.records) !== JSON.stringify(snapshot.records)
					? "changed"
					: "unchanged",
			);
		} catch (error) {
			this.queue.finish(
				job.id,
				false,
				this.closed
					? "observation_cancelled"
					: error instanceof ModelRequestError
						? error.code
						: error instanceof Error &&
								[
									"duplicate observation slot",
									"only concerns can be resolved",
									"self/relationship evidence must be inferred",
								].includes(error.message)
							? error.message.replaceAll(" ", "_")
							: stage,
			);
		}
		this.changed();
	}
	/** Race cancellation even when an injected observer ignores its signal. Late output is inert. */
	private async observe(observer: Observer, prompt: string): Promise<string> {
		const controller = new AbortController();
		const abort = () => controller.abort(this.controller.signal.reason);
		this.controller.signal.addEventListener("abort", abort, { once: true });
		const cancelTimeout = this.schedule(
			() => controller.abort(Error("Observation timed out")),
			OBSERVE_TIMEOUT_MS,
		);
		let rejectAbort: () => void = () => {};
		try {
			const cancelled = new Promise<never>((_, reject) => {
				rejectAbort = () => reject(controller.signal.reason);
				controller.signal.addEventListener("abort", rejectAbort, {
					once: true,
				});
			});
			if (this.controller.signal.aborted) abort();
			controller.signal.throwIfAborted();
			return await Promise.race([
				observer(prompt, controller.signal),
				cancelled,
			]);
		} finally {
			cancelTimeout();
			this.controller.signal.removeEventListener("abort", abort);
			controller.signal.removeEventListener("abort", rejectAbort);
		}
	}
	private changed(): void {
		if (!this.closed) this.options.onChange?.();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.cancelWake?.();
		this.controller.abort();
		this.closing = (async () => {
			try {
				await this.inflight;
			} finally {
				this.queue.close();
				this.mind.close();
			}
		})();
		return this.closing;
	}
}
