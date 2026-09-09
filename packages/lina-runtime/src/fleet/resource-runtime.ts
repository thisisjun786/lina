import { CodexHost } from "../../../lina-codex/src/host.ts";
import type {
	TaskManagerOptions,
	TaskToolContext,
} from "../../../lina-codex/src/task-rpc.ts";
import type { ResourceContentLimits } from "../../../lina-memory/src/resources/content.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import type { LinaHost } from "../host.ts";
import { ResourceEngine } from "../resources/services.ts";

interface Options {
	root: string;
	limits: ResourceContentLimits;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
	validAgent: (id: string) => boolean;
	assertInstallation: () => void;
}
/** One installation catalog, immutable consumer scopes, and serialized durable jobs. */
export class FleetResources {
	readonly engine: ResourceEngine;
	private closed = false;
	private lastFailure: "RESOURCE_PROCESSING_FAILED" | null = null;
	status() {
		return {
			state: this.closed ? "closed" : "open",
			processingError: this.lastFailure,
		};
	}
	private tail: Promise<void> = Promise.resolve();
	private tasks = new Set<Promise<unknown>>();
	private clients = new Map<string, ReturnType<ResourceEngine["consumer"]>>();
	private stopping: Promise<void> | undefined;
	constructor(private options: Options) {
		options.assertInstallation();
		this.engine = new ResourceEngine({
			root: options.root,
			limits: options.limits,
			scope: () => this.scope(null),
			services: options.services,
			policy: options.policy,
			assertRecoveryOwnership: options.assertInstallation,
		});
		this.engine.recover();
	}
	scope(id: string | null): ResourceScope {
		this.open();
		if (id !== null && !this.options.validAgent(id))
			throw Error("unknown resource agent");
		return {
			principalId: id === null ? "external" : `agent:${id}`,
			agentId: id,
			allowedVisibilities: id === null ? ["shared"] : ["private", "shared"],
		};
	}
	private open() {
		if (this.closed) throw Error("resource installation closed");
		this.options.assertInstallation();
	}
	consumer(id: string | null) {
		this.open();
		const key = id ?? "external";
		let client = this.clients.get(key);
		if (!client) {
			client = this.engine.consumer(
				() => this.scope(id),
				(r) => this.schedule(id, r.id),
			);
			this.clients.set(key, client);
		}
		return client;
	}
	install(host: LinaHost, id: string) {
		this.consumer(id).install(host);
	}
	dynamicTools() {
		const host = new CodexHost(this.options.root, () => ({ action: "allow" }));
		this.consumer(null).install(host.asLinaHost());
		return [...host.tools.values()].map((t) => ({
			type: "function" as const,
			name: t.name,
			description: t.description,
			inputSchema: t.parameters,
		}));
	}
	schedule(id: string | null, resourceId: string) {
		this.open();
		const scope = this.scope(id);
		const run = this.tail.then(async () => {
			if (this.closed) return;
			const results = await this.engine.runPending(
				resourceId,
				new AbortController().signal,
				() => {
					if (id !== null && !this.options.validAgent(id))
						throw Error("resource agent unavailable");
					return scope;
				},
			);
			this.lastFailure = results.some(
				(r) =>
					r.state === "failed" ||
					r.state === "unknown" ||
					r.state === "exhausted",
			)
				? "RESOURCE_PROCESSING_FAILED"
				: null;
		});
		this.tail = run.catch(() => {
			this.lastFailure = "RESOURCE_PROCESSING_FAILED";
		});
	}
	readonly executeTool: NonNullable<TaskManagerOptions["executeTool"]> = (
		name,
		callId,
		args,
		signal,
		context?: TaskToolContext,
	) => {
		this.open();
		const run = this.engine.execute(async (combined) => {
			context?.assertCurrent();
			const id = context?.agentId ?? null;
			const host = new CodexHost(this.options.root, () => ({
				action: "allow",
			}));
			const client = this.engine.consumer(
				() => {
					context?.assertCurrent();
					return this.scope(id);
				},
				(r) => this.schedule(id, r.id),
			);
			client.install(host.asLinaHost());
			const result = await host.invokeTool(name, callId, args, combined);
			context?.assertCurrent();
			return result;
		}, signal);
		this.tasks.add(run);
		void run.then(
			() => this.tasks.delete(run),
			() => this.tasks.delete(run),
		);
		return run;
	};
	async drain() {
		await this.tail;
	}
	close(): Promise<void> {
		if (this.stopping) return this.stopping;
		this.closed = true;
		this.stopping = (async () => {
			await this.engine.close();
			await Promise.allSettled([this.tail, ...this.tasks]);
			this.clients.clear();
		})();
		return this.stopping;
	}
}
