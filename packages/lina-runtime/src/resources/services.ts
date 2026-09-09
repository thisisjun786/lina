import { canonical } from "../../../lina-memory/src/resources/codec.ts";
import type { ResourceContentLimits } from "../../../lina-memory/src/resources/content.ts";
import { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import type { LinaHost } from "../host.ts";
import { memoryGeneration, ResourceMemoryWorker } from "./memory-worker.ts";
import { ResourceSearch } from "./search.ts";
import { installResourceTools } from "./tools.ts";
import { ResourceWorker, resourceGeneration } from "./worker.ts";

interface Options {
	root: string;
	limits: ResourceContentLimits;
	scope: () => ResourceScope;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
	assertRecoveryOwnership?: () => void;
}
/** Installation composition boundary. Scope and model services are host-owned getters. */
export class ResourceEngine {
	readonly store: ResourceStore;
	readonly search: ResourceSearch;
	private readonly inflight = new Set<Promise<unknown>>();
	private readonly abort = new AbortController();
	private busy = false;
	private closed = false;
	private closing: Promise<void> | undefined;
	private drained: ReturnType<typeof Promise.withResolvers<void>> | undefined;
	constructor(private readonly options: Options) {
		this.store = new ResourceStore(
			options.root,
			options.limits,
			(kind) => resourceGeneration(options.services(), options.policy(), kind),
			() => memoryGeneration(options.services(), options.policy()),
		);
		const shared = {
			store: this.store,
			scope: options.scope,
			services: options.services,
			policy: options.policy,
		};
		this.search = this.ownedSearch(
			new ResourceSearch({
				...shared,
				scope: () => {
					this.open();
					return options.scope();
				},
			}),
		);
	}
	execute<T>(
		run: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		return this.track(run, signal);
	}
	private ownedSearch(search: ResourceSearch): ResourceSearch {
		const execute = search.search.bind(search);
		search.search = (input, signal) =>
			this.track((combined) => execute(input, combined), signal);
		return search;
	}
	private track<T>(
		run: (signal: AbortSignal) => Promise<T>,
		signal: AbortSignal,
	): Promise<T> {
		this.open();
		const combined = AbortSignal.any([signal, this.abort.signal]);
		const task = Promise.resolve().then(() => {
			combined.throwIfAborted();
			return run(combined);
		});
		this.inflight.add(task);
		void task.then(
			() => this.inflight.delete(task),
			() => this.inflight.delete(task),
		);
		return task;
	}
	consumer(
		scopeGetter: () => ResourceScope,
		onStored?: (
			resource: import("../../../lina-memory/src/resources/types.ts").Resource,
		) => void,
	) {
		this.open();
		const scope = () => {
			this.open();
			return scopeGetter();
		};
		const search = this.ownedSearch(
			new ResourceSearch({
				store: this.store,
				scope,
				services: this.options.services,
				policy: this.options.policy,
			}),
		);
		return {
			scope,
			search,
			install: (host: LinaHost) => {
				this.open();
				installResourceTools(host, {
					store: this.store,
					scope,
					search,
					...(onStored ? { onStored } : {}),
				});
			},
		};
	}
	install(host: LinaHost): void {
		this.open();
		installResourceTools(host, {
			store: this.store,
			scope: () => {
				this.open();
				return this.options.scope();
			},
			search: this.search,
		});
	}
	async runPending(
		resourceId: string,
		signal: AbortSignal,
		scope: () => ResourceScope = this.options.scope,
	) {
		this.open();
		if (this.busy) throw Error("resource worker busy");
		this.busy = true;
		this.drained = Promise.withResolvers<void>();
		const shared = {
			store: this.store,
			scope,
			services: this.options.services,
			policy: this.options.policy,
		};
		const worker = new ResourceWorker(shared),
			memoryWorker = new ResourceMemoryWorker(shared);
		try {
			this.store.indexing.refresh();
			const order = { extract: 0, brief: 1, overview: 2 };
			const jobs = this.store.indexing
				.list(scope(), resourceId)
				.filter(
					(job) =>
						job.state === "pending" &&
						canonical(job.generation) ===
							canonical(
								resourceGeneration(
									this.options.services(),
									this.options.policy(),
									job.kind,
								),
							),
				)
				.sort((a, b) => order[a.kind] - order[b.kind]);
			const results = [];
			const combined = AbortSignal.any([signal, this.abort.signal]);
			for (const job of jobs) {
				combined.throwIfAborted();
				results.push(await worker.run(job.id, combined));
			}
			const memory = await memoryWorker.run(resourceId, combined);
			if (
				!(
					memory.state === "unavailable" &&
					memory.reason === "no_pending_capture"
				)
			)
				results.push(memory);
			return results;
		} finally {
			this.busy = false;
			this.drained?.resolve();
		}
	}
	recover() {
		this.open();
		if (
			this.busy ||
			this.inflight.size > 0 ||
			!this.options.assertRecoveryOwnership
		)
			throw Error("exclusive resource recovery ownership required");
		this.options.assertRecoveryOwnership();
		return this.store.recoverOwnedState();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.abort.abort(new Error("resource engine closed"));
		this.closing = (async () => {
			await Promise.allSettled([
				...this.inflight,
				...(this.busy && this.drained ? [this.drained.promise] : []),
			]);
			this.store.close();
		})();
		return this.closing;
	}
	private open(): void {
		if (this.closed) throw Error("resource engine closed");
	}
}
