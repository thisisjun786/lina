import type { DurableStore } from "../../lina-core/src/index.ts";
import type {
	BotBinding,
	SessionSnapshot,
} from "../../lina-core/src/protocol.ts";
import { type DispatchSlot, PromptLane } from "./prompt-lane.ts";
import { RuntimeCancellation } from "./runtime-cancellation.ts";
import type { RuntimeNotice, RuntimeOptions } from "./runtime-types.ts";
import {
	decodeNativeEvent,
	type NativeEvent,
	projectNativeEntry,
} from "./sdk-events.ts";
import type { SessionPort } from "./sdk-port.ts";
import { sessionSnapshot } from "./snapshot.ts";

export type { RuntimeNotice, RuntimeOptions } from "./runtime-types.ts";

/** One dispatch lane; queued SDK promises are admission receipts, never completion. */
export class DurableRuntime {
	private readonly listeners = new Set<(event: RuntimeNotice) => void>();
	private readonly lane: PromptLane;
	private readonly cancellation: RuntimeCancellation;
	private observedRun = false;
	private get active() {
		return this.lane.active;
	}
	private get correlation() {
		return this.lane.correlation;
	}
	private get admission() {
		return this.lane.admission;
	}
	private settling = false;
	private running = false;
	private closed = false;
	private failure: string | undefined;
	private liveText = "";
	private readonly unsubscribe: () => void;

	constructor(
		readonly native: SessionPort,
		readonly store: DurableStore,
		readonly binding: BotBinding,
		private readonly options: RuntimeOptions = {},
	) {
		if (
			native.sessionId !== binding.sessionId ||
			native.sessionFile !== binding.sessionFile
		)
			throw new Error("Native session differs from its fixed binding");
		this.lane = new PromptLane(native, store, {
			accept: () => !this.closed && !this.settling && !this.cancellation.active,
			changed: () => this.publish(),
			started: () => {
				this.running = true;
			},
			reject: (slot, error) => this.reject(slot, error),
			failed: (slot, error) => this.promptFailed(slot, error),
			released: () => {
				if (!this.closed) {
					if (this.settling) this.finishSettlement();
					else this.lane.pump();
				}
			},
		});
		this.cancellation = new RuntimeCancellation({
			known: (id) => !this.closed && this.lane.contains(id),
			fence: () => {
				this.lane.discardQueued();
				this.native.clearQueue();
				return this.lane.abortAdmission();
			},
			beforeAbort: () => this.options.beforeAbort?.(),
			abort: () => this.native.abort(),
			hasRun: () => this.observedRun || this.native.hasActiveRun(),
			finish: () => {
				this.beginSettlement();
				if (this.admission) throw new Error("Admission has not drained");
			},
			changed: () => this.publish(),
		});
		store.recover();
		for (const raw of native.history()) {
			const entry = projectNativeEntry(raw);
			if (entry) this.appendEntry(entry);
		}
		this.options.recoverPending?.();
		this.unsubscribe = native.subscribe((raw) => {
			const event = decodeNativeEvent(raw);
			if (event && !this.closed) this.receive(event);
		});
	}

	subscribe(listener: (event: RuntimeNotice) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	snapshot(): SessionSnapshot {
		return sessionSnapshot(
			this.store,
			this.binding,
			this.cancellation.active ||
				this.running ||
				this.settling ||
				this.admission !== undefined ||
				this.lane.queued.length > 0,
		);
	}

	submit(id: string, text: string) {
		this.options.beforeSubmit?.();
		if (this.closed || this.cancellation.active)
			throw new Error("Lina is stopping current work");
		const result = this.store.createRequest(id, text);
		if (result.created) {
			this.lane.queued.push(result.request);
			this.publish();
			this.lane.pump();
		}
		return result;
	}

	get isCancelling(): boolean {
		return this.cancellation.active;
	}
	get cancelFailed(): boolean {
		return this.cancellation.failed;
	}
	currentRequestId(): string | undefined {
		return this.lane.currentRequestId();
	}
	cancelRequestId(): string | null {
		return this.cancellation.target ?? this.lane.cancelRequestId();
	}
	async cancel(requestId: string): Promise<void> {
		return this.cancellation.run(requestId);
	}

	private reject(slot: DispatchSlot, error: string): void {
		if (!this.active.has(slot.id)) return;
		this.store.setRequest(slot.id, slot.consumed ? "interrupted" : "rejected", {
			error,
		});
		this.options.finalizeRequest?.(slot.id);
		this.active.delete(slot.id);
		const position = this.correlation.indexOf(slot);
		if (position >= 0) this.correlation.splice(position, 1);
		this.publish();
	}

	private promptFailed(slot: DispatchSlot, error: unknown): void {
		if (
			this.closed ||
			this.settling ||
			this.cancellation.active ||
			!this.active.has(slot.id)
		)
			return;
		const message =
			error instanceof Error ? error.message : "Native prompt failed";
		if (!slot.admitted && !slot.consumed) {
			this.reject(slot, message);
			return;
		}
		this.failure = message;
		void this.native.abort().then(
			() => {
				if (this.active.has(slot.id)) this.beginSettlement();
			},
			() =>
				this.emit({
					type: "warning",
					message: "Native abort failed; execution state needs attention",
				}),
		);
	}

	private receive(event: NativeEvent): void {
		switch (event.type) {
			case "entry": {
				const inserted = this.appendEntry(event.entry);
				if (event.entry.role === "user") {
					const proof = this.native.sourceEntryPolicy?.(event.entry.entryId);
					// Optional legacy ports retain lifecycle compatibility, never source eligibility.
					const slot = this.native.sourceEntryPolicy
						? proof && this.active.get(proof.requestId)
						: inserted && this.correlation[0]?.text === event.entry.text
							? this.correlation[0]
							: undefined;
					if (slot && !slot.consumed) {
						const index = this.correlation.indexOf(slot);
						if (index >= 0) this.correlation.splice(index, 1);
						slot.consumed = true;
						this.store.setRequest(slot.id, "accepted", {
							entryId: event.entry.entryId,
						});
					} else
						this.emit({
							type: "warning",
							message:
								"A native user entry could not be correlated to its dispatched request",
						});
				}
				if (event.entry.role === "assistant") this.liveText = "";
				this.publish();
				return;
			}
			case "start":
				this.observedRun = true;
				this.failure = undefined;
				this.running = true;
				this.publish();
				return;
			case "settled":
				this.observedRun = false;
				this.cancellation.nativeSettled();
				this.beginSettlement();
				return;
			case "failure":
				this.failure = event.error;
				return;
			case "text":
				this.liveText = (this.liveText + event.delta).slice(-16_384);
				this.emit({
					type: "live-text",
					sessionId: this.binding.sessionId,
					text: this.liveText,
				});
				return;
			case "text-end":
				this.emit({ type: "legacy-text", text: event.text });
				return;
		}
	}

	private beginSettlement(): void {
		if (this.closed || this.settling) return;
		this.settling = true;
		this.native.clearQueue();
		this.admission?.controller.abort();
		this.finishSettlement();
	}

	private finishSettlement(): void {
		if (!this.settling || this.admission || this.closed) return;
		for (const slot of this.active.values()) {
			const success =
				slot.consumed &&
				this.failure === undefined &&
				!this.cancellation.active;
			this.store.setRequest(
				slot.id,
				success ? "settled" : "interrupted",
				success
					? {}
					: {
							error:
								(this.cancellation.active
									? "Cancelled by user"
									: this.failure) ??
								"Queued input was not consumed before settlement",
						},
			);
			this.options.finalizeRequest?.(slot.id);
		}
		this.active.clear();
		this.correlation.length = 0;
		this.running = false;
		this.settling = false;
		this.failure = undefined;
		this.liveText = "";
		this.publish();
		this.lane.pump();
	}

	private emit(event: RuntimeNotice): void {
		if (!this.closed) for (const listener of this.listeners) listener(event);
	}
	private appendEntry(
		entry: import("../../lina-core/src/protocol.ts").EntryInput,
	): boolean {
		const proof = this.native.sourceEntryPolicy?.(entry.entryId);
		if (!proof) return this.store.appendEntry(entry);
		const policy = this.store.requestSourcePolicy(proof.requestId);
		if (
			proof.entryId !== entry.entryId ||
			proof.sessionId !== this.binding.sessionId ||
			policy?.nativeEpoch !== proof.nativeEpoch ||
			policy.scopeDigest !== proof.scopeDigest
		)
			throw Error("Native entry source differs from journal binding");
		return this.store.appendSourceEntry(entry, proof.requestId);
	}
	private publish(): void {
		if (!this.closed)
			this.emit({ type: "snapshot", snapshot: this.snapshot() });
	}

	detach(): void {
		this.closed = true;
		this.unsubscribe();
		this.listeners.clear();
		this.admission?.controller.abort();
	}

	async close(): Promise<void> {
		const target = this.cancelRequestId();
		if (target) await this.cancel(target);
		else {
			this.options.beforeAbort?.();
			await this.native.abort();
		}
		this.native.clearQueue();
		this.detach();
		this.store.recover();
		await this.native.close();
	}
}
