import { AsyncLocalStorage } from "node:async_hooks";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHost } from "../../../lina-codex/src/host.ts";
import type {
	TaskManagerOptions,
	TaskToolContext,
} from "../../../lina-codex/src/task-rpc.ts";
import {
	checkedDirectory,
	checkedRegular,
	readRegular,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { ResourceActivitySource } from "../../../lina-core/src/world/work-types.ts";
import { ResourceActivities } from "../../../lina-memory/src/resources/activities.ts";
import type { ResourceContentLimits } from "../../../lina-memory/src/resources/content.ts";
import { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import type { EnginePolicySnapshot } from "../context/policy-settings.ts";
import type { ContextServices } from "../context/port.ts";
import type { LinaHost } from "../host.ts";
import { createResourceActivityBridge } from "../life/resource-bridge.ts";
import { installActivityTools } from "../resources/activity-tools.ts";
import { ResourceEngine } from "../resources/services.ts";

interface Options {
	root: string;
	limits: ResourceContentLimits;
	services: () => ContextServices;
	policy: () => EnginePolicySnapshot;
	validAgent: (id: string) => boolean;
	assertInstallation: () => void;
	isWorldParticipant?: (worldId: string, agentId: string) => boolean;
	onActivityChanged?: (worldId: string) => void;
}
type TaskSearchSession = {
	client: ReturnType<ResourceEngine["consumer"]>;
	dispose(): void;
};
type TaskSearchKey = string | AbortSignal;
type TaskSearchCall = {
	key: TaskSearchKey;
	context: TaskToolContext | undefined;
	signal: AbortSignal;
};
const MAX_TASK_SEARCHES = 64;
/** Validate recovery and migrations on copies; SQLite must not recover rejected originals. */
function validateStoredResources(
	root: string,
	limits: ResourceContentLimits,
): void {
	const catalog = join(root, "catalog.sqlite");
	if (!existsSync(catalog) && !existsSync(join(root, "activities.sqlite")))
		return;
	checkedDirectory(root, false);
	const files = () => {
		const names = [
			"catalog.sqlite",
			"catalog.sqlite-wal",
			"catalog.sqlite-journal",
			"catalog.sqlite-shm",
			"activities.sqlite",
			"activities.sqlite-wal",
			"activities.sqlite-journal",
			"activities.sqlite-shm",
		];
		const blobs = join(root, "blobs");
		if (existsSync(blobs)) {
			checkedDirectory(blobs, false);
			const entries = readdirSync(blobs);
			if (entries.length > 4096)
				throw Error("resource blob count limit exceeded");
			names.push(...entries.map((name) => join("blobs", name)));
		}
		return names.sort();
	};
	const stamp = () =>
		JSON.stringify(
			files().map((name) => {
				const path = join(root, name);
				checkedRegular(path, false);
				const stat = lstatSync(path, { throwIfNoEntry: false });
				return stat
					? [name, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
					: [name, null];
			}),
		);
	const before = stamp();
	const temporary = mkdtempSync(join(tmpdir(), "lina-resource-validation-"));
	try {
		checkedDirectory(join(temporary, "blobs"), true);
		let blobBytes = 0;
		for (const name of files()) {
			const path = join(root, name);
			// The WAL index is ephemeral; SQLite rebuilds it only in the private copy.
			if (!existsSync(path) || name.endsWith(".sqlite-shm")) continue;
			const blob = name.startsWith("blobs/");
			const bytes = readRegular(
				path,
				blob ? 64 * 1024 * 1024 : Number.MAX_SAFE_INTEGER,
			);
			if (blob) {
				blobBytes += bytes.length;
				if (blobBytes > 64 * 1024 * 1024)
					throw Error("resource catalog limit exceeded");
			}
			writeExclusive(join(temporary, name), bytes);
		}
		if (stamp() !== before)
			throw Error("resource storage changed during validation");
		const probe = new ResourceStore(temporary, limits);
		try {
			probe.recoverOwnedState();
			if (existsSync(join(temporary, "activities.sqlite"))) {
				// Read-only integrity audit never originates activities or grants.
				const activities = new ResourceActivities(temporary, probe, {
					isWorldParticipant: () => false,
				});
				activities.close();
			}
		} finally {
			probe.close();
		}
		if (stamp() !== before)
			throw Error("resource storage changed during validation");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

/** One installation catalog, immutable consumer scopes, and serialized durable jobs. */
export class FleetResources {
	readonly engine: ResourceEngine;
	private readonly activityLedger: ResourceActivities;
	get activities(): ResourceActivities {
		this.open();
		return this.activityLedger;
	}
	activityBridge(world: Pick<WorldStore, "admitWorkInput">) {
		this.open();
		const bridge = createResourceActivityBridge({
			source: this.activityLedger,
			scope: this.scope(null),
			world,
		});
		return {
			poll: (worldId: string) => {
				this.open();
				return bridge.poll(worldId);
			},
			current: (worldId: string, source: ResourceActivitySource) => {
				this.open();
				return this.activityLedger.current(this.scope(null), worldId, source);
			},
		};
	}
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
	private readonly taskSearches = new Map<TaskSearchKey, TaskSearchSession>();
	private readonly taskCall = new AsyncLocalStorage<TaskSearchCall>();
	private stopping: Promise<void> | undefined;
	constructor(private options: Options) {
		options.assertInstallation();
		validateStoredResources(options.root, options.limits);
		options.assertInstallation();
		this.engine = new ResourceEngine({
			root: options.root,
			limits: options.limits,
			scope: () => this.scope(null),
			services: options.services,
			policy: options.policy,
			assertRecoveryOwnership: options.assertInstallation,
		});
		try {
			this.engine.recover();
			this.activityLedger = new ResourceActivities(
				options.root,
				this.engine.store,
				{
					isWorldParticipant: (worldId, agentId) => {
						this.open();
						return (
							options.validAgent(agentId) &&
							(options.isWorldParticipant?.(worldId, agentId) ?? false)
						);
					},
				},
			);
		} catch (error) {
			// Construction has not exposed consumers or started asynchronous jobs.
			this.engine.store.close();
			throw error;
		}
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
		installActivityTools(host, {
			ledger: this.activities,
			...(this.options.onActivityChanged
				? { changed: this.options.onActivityChanged }
				: {}),
			scope: () => this.scope(id),
		});
	}
	dynamicTools() {
		const host = new CodexHost(this.options.root, () => ({ action: "allow" }));
		this.consumer(null).install(host.asLinaHost());
		installActivityTools(host.asLinaHost(), {
			ledger: this.activities,
			...(this.options.onActivityChanged
				? { changed: this.options.onActivityChanged }
				: {}),
			scope: () => this.scope(null),
		});
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
	private taskSearch(
		key: TaskSearchKey,
		signal: AbortSignal,
		id: string | null,
	) {
		const cached = this.taskSearches.get(key);
		if (cached) return cached;
		const client = this.engine.consumer(
			() => {
				const call = this.taskCall.getStore();
				if (!call || call.key !== key)
					throw Error("Resource task context unavailable");
				call.signal.throwIfAborted();
				call.context?.assertCurrent();
				return this.scope(id);
			},
			(r) => this.schedule(id, r.id),
		);
		const remove = () => {
			if (this.taskSearches.get(key) === session) this.taskSearches.delete(key);
			signal.removeEventListener("abort", remove);
		};
		const session = { client, dispose: remove };
		this.taskSearches.set(key, session);
		signal.addEventListener("abort", remove, { once: true });
		while (this.taskSearches.size > MAX_TASK_SEARCHES) {
			this.taskSearches.values().next().value?.dispose();
		}
		return session;
	}
	readonly executeTool: NonNullable<TaskManagerOptions["executeTool"]> = (
		name,
		callId,
		args,
		signal,
		context?: TaskToolContext,
	) => {
		this.open();
		const key: TaskSearchKey = context
			? JSON.stringify([context.taskId, context.agentId, context.revision])
			: signal;
		const run = this.engine.execute(
			(combined) =>
				this.taskCall.run({ key, context, signal: combined }, async () => {
					context?.assertCurrent();
					const id = context?.agentId ?? null;
					const host = new CodexHost(this.options.root, () => ({
						action: "allow",
					}));
					const session = this.taskSearch(key, signal, id);
					const cancel = () => session.dispose();
					combined.addEventListener("abort", cancel, { once: true });
					try {
						session.client.install(host.asLinaHost());
						installActivityTools(host.asLinaHost(), {
							ledger: this.activities,
							...(this.options.onActivityChanged
								? { changed: this.options.onActivityChanged }
								: {}),
							scope: () => {
								context?.assertCurrent();
								return this.scope(id);
							},
						});
						const result = await host.invokeTool(name, callId, args, combined);
						context?.assertCurrent();
						return result;
					} finally {
						combined.removeEventListener("abort", cancel);
					}
				}),
			signal,
		);
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
			this.activityLedger.close();
			this.clients.clear();
			for (const session of this.taskSearches.values()) session.dispose();
			this.taskCall.disable();
		})();
		return this.stopping;
	}
}
