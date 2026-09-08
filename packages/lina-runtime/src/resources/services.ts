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
	private readonly worker: ResourceWorker;
	private readonly memoryWorker: ResourceMemoryWorker;
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
		this.search = new ResourceSearch(shared);
		this.worker = new ResourceWorker(shared);
		this.memoryWorker = new ResourceMemoryWorker(shared);
	}
	install(host: LinaHost): void {
		this.open();
		installResourceTools(host, {
			store: this.store,
			scope: this.options.scope,
			search: this.search,
		});
	}
	async runPending(resourceId: string, signal: AbortSignal) {
		this.open();
		if (this.busy) throw Error("resource worker busy");
		this.busy = true;
		this.drained = Promise.withResolvers<void>();
		try {
			this.store.indexing.refresh();
			const order = { extract: 0, brief: 1, overview: 2 };
			const jobs = this.store.indexing
				.list(this.options.scope(), resourceId)
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
				results.push(await this.worker.run(job.id, combined));
			}
			const memory = await this.memoryWorker.run(resourceId, combined);
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
		if (this.busy || !this.options.assertRecoveryOwnership)
			throw Error("exclusive resource recovery ownership required");
		this.options.assertRecoveryOwnership();
		return this.store.recoverOwnedState();
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.abort.abort(new Error("resource engine closed"));
		if (!this.busy) {
			this.store.close();
			this.closing = Promise.resolve();
		} else
			this.closing = (async () => {
				await this.drained?.promise;
				this.store.close();
			})();
		return this.closing;
	}
	private open(): void {
		if (this.closed) throw Error("resource engine closed");
	}
}
