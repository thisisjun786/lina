import { randomUUID } from "node:crypto";
import type { ContextStore } from "../../../lina-core/src/context/index.ts";
import type { ContextSnapshot } from "../../../lina-core/src/context-wire.ts";
import type { DurableRuntime } from "../runtime.ts";
import type { ContextCoordinator } from "./coordinator.ts";
import type { MemoryPort } from "./memory.ts";

type Options = {
	runtime: DurableRuntime;
	coordinator: ContextCoordinator;
	store: ContextStore;
	memory: Pick<MemoryPort, "status" | "refresh">;
};
export class ContextChannel {
	private readonly epoch = randomUUID();
	private revision = 0;
	private readonly listeners = new Set<(state: ContextSnapshot) => void>();
	private readonly off: (() => void)[];
	private closed = false;
	constructor(private readonly options: Options) {
		this.off = [
			options.coordinator.subscribe(() => this.changed()),
			options.runtime.subscribe((event) => {
				if (event.type !== "snapshot") return;
				this.changed();
				if (event.snapshot.state === "idle") void options.memory.refresh();
			}),
		];
	}
	get isBusy(): boolean {
		return this.options.coordinator.isBusy;
	}
	snapshot(): ContextSnapshot {
		const state = this.options.coordinator.state();
		return {
			sessionId: this.options.runtime.binding.sessionId,
			epoch: this.epoch,
			revision: this.revision,
			busy: this.isBusy,
			usage: {
				...this.options.runtime.native.usage(),
				estimated: true,
				injectionTokens: state.injectionTokens,
				injectionOmitted: state.injectionOmitted,
			},
			compaction: {
				status: state.status,
				activeId: state.activeId,
				recoveryNeeded: state.recoveryNeeded,
				sourceCount: state.sourceCount,
			},
			working: this.options.store.working(),
			memory: this.options.memory.status(),
		};
	}
	changed(): void {
		if (this.closed) return;
		this.revision++;
		const state = this.snapshot();
		for (const listener of this.listeners) listener(state);
	}
	subscribe(listener: (state: ContextSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async refresh(): Promise<void> {
		await this.options.memory.refresh();
		this.changed();
	}
	async compact(): Promise<void> {
		await this.options.coordinator.manual();
		this.changed();
	}
	close(): void {
		this.closed = true;
		for (const off of this.off) off();
		this.listeners.clear();
	}
}
