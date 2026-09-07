import type { DurableStore, RequestRecord } from "../../lina-core/src/index.ts";
import type { SessionPort } from "./sdk-port.ts";

export type DispatchSlot = {
	id: string;
	text: string;
	controller: AbortController;
	admitted: boolean;
	consumed: boolean;
	drained: Promise<void>;
};
type LaneEvents = {
	accept(): boolean;
	changed(): void;
	started(): void;
	released(): void;
	reject(slot: DispatchSlot, error: string): void;
	failed(slot: DispatchSlot, error: unknown): void;
};

/** Serialize admission while allowing the SDK to consume its steering queue. */
export class PromptLane {
	readonly queued: RequestRecord[] = [];
	readonly active = new Map<string, DispatchSlot>();
	readonly correlation: DispatchSlot[] = [];
	admission: DispatchSlot | undefined;

	constructor(
		private readonly native: SessionPort,
		private readonly store: DurableStore,
		private readonly events: LaneEvents,
	) {}

	pump(): void {
		if (!this.events.accept() || this.admission) return;
		const request = this.queued.shift();
		if (!request) return;
		const drained = Promise.withResolvers<void>();
		const slot: DispatchSlot = {
			id: request.id,
			text: request.text,
			controller: new AbortController(),
			admitted: false,
			consumed: false,
			drained: drained.promise,
		};
		this.active.set(slot.id, slot);
		this.correlation.push(slot);
		this.admission = slot;
		const ready = Promise.withResolvers<void>();
		this.events.changed();
		const disposition = (value: "started" | "queued" | "handled") => {
			try {
				if (this.events.accept() && this.active.has(slot.id)) {
					if (value === "handled")
						this.events.reject(slot, "Input was intercepted before execution");
					else {
						slot.admitted = true;
						this.events.started();
						this.store.setRequest(slot.id, "accepted");
						this.events.changed();
					}
				}
			} finally {
				ready.resolve();
			}
		};
		const rejected = () => {
			try {
				if (this.events.accept())
					this.events.reject(slot, "Prompt admission rejected");
			} finally {
				ready.resolve();
			}
		};
		try {
			void this.native
				.prompt(slot.text, {
					signal: slot.controller.signal,
					disposition,
					rejected,
				})
				.then(
					() => {
						if (
							!slot.admitted &&
							!slot.consumed &&
							this.events.accept() &&
							this.active.has(slot.id)
						)
							rejected();
						ready.resolve();
					},
					(error: unknown) => {
						try {
							this.events.failed(slot, error);
						} finally {
							ready.resolve();
						}
					},
				);
		} catch (error) {
			try {
				this.events.failed(slot, error);
			} finally {
				ready.resolve();
			}
		}
		void ready.promise.then(() => {
			if (this.admission === slot) this.admission = undefined;
			try {
				this.events.released();
				this.events.changed();
			} finally {
				drained.resolve();
			}
		});
	}

	currentRequestId(): string | undefined {
		return [...this.active.values()].findLast((slot) => slot.consumed)?.id;
	}
	cancelRequestId(): string | null {
		return (
			(this.admission && this.active.has(this.admission.id)
				? this.admission.id
				: undefined) ??
			this.currentRequestId() ??
			[...this.active.keys()].at(-1) ??
			this.queued[0]?.id ??
			null
		);
	}
	contains(id: string): boolean {
		return (
			this.active.has(id) || this.queued.some((request) => request.id === id)
		);
	}
	abortAdmission(): Promise<void> {
		const slot = this.admission;
		slot?.controller.abort();
		return slot?.drained ?? Promise.resolve();
	}
	discardQueued(): void {
		for (const request of this.queued)
			this.store.setRequest(request.id, "interrupted", {
				error: "Cancelled by user",
			});
		this.queued.length = 0;
	}
}
