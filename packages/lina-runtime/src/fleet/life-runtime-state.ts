import { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { LifeForeground } from "../life/runner.ts";
import { ModelSettingsStore } from "../models/settings.ts";
import type { DurableRuntime } from "../runtime.ts";

/** Synchronous admission notifications fence LIFE before foreground native dispatch. */
export class FleetLifeForeground implements LifeForeground {
	private readonly busy = new Set<unknown>();
	private readonly listeners = new Set<() => void>();
	private readonly subscriptions = new Map<DurableRuntime, () => void>();
	active = () => this.busy.size > 0;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	set(key: unknown, active: boolean) {
		const before = this.active();
		if (active) this.busy.add(key);
		else this.busy.delete(key);
		if (before !== this.active())
			for (const listener of this.listeners) listener();
	}
	begin() {
		const key = {};
		this.set(key, true);
		return () => this.set(key, false);
	}
	track(runtime: DurableRuntime) {
		if (this.subscriptions.has(runtime)) return;
		this.set(runtime, runtime.snapshot().state !== "idle");
		this.subscriptions.set(
			runtime,
			runtime.subscribe((event) => {
				if (event.type === "snapshot")
					this.set(runtime, event.snapshot.state !== "idle");
			}),
		);
	}
	forget(runtime: DurableRuntime) {
		this.subscriptions.get(runtime)?.();
		this.subscriptions.delete(runtime);
		this.set(runtime, false);
	}
	close() {
		for (const off of this.subscriptions.values()) off();
		this.subscriptions.clear();
		this.listeners.clear();
		this.busy.clear();
	}
}

/** Only successful profile/settings commits notify the installation runtime. */
export class FleetLifeAgents extends AgentStore {
	constructor(
		path: string,
		private readonly changed: () => void,
	) {
		super(path);
	}
	override create(...args: Parameters<AgentStore["create"]>) {
		const result = super.create(...args);
		this.changed();
		return result;
	}
	override update(...args: Parameters<AgentStore["update"]>) {
		const result = super.update(...args);
		this.changed();
		return result;
	}
	override applyAuthored(...args: Parameters<AgentStore["applyAuthored"]>) {
		const before = this.get(args[0].id)?.revision;
		const result = super.applyAuthored(...args);
		if (before !== this.get(args[0].id)?.revision) this.changed();
		return result;
	}
	private visualChange<T>(id: string, operation: () => T): T {
		const before = this.visual(id).revision;
		const result = operation();
		if (before !== this.visual(id).revision) this.changed();
		return result;
	}
	override updateVisual(...args: Parameters<AgentStore["updateVisual"]>) {
		return this.visualChange(args[0], () => super.updateVisual(...args));
	}
	override putVisualGrant(...args: Parameters<AgentStore["putVisualGrant"]>) {
		const before = this.visualGrants(args[0]).find(
			(grant) => grant.id === args[2].id,
		)?.revision;
		const result = super.putVisualGrant(...args);
		if (before !== result.revision) this.changed();
		return result;
	}
	override setAvatarPinned(...args: Parameters<AgentStore["setAvatarPinned"]>) {
		return this.visualChange(args[0], () => super.setAvatarPinned(...args));
	}
	override applyAvatarOnce(...args: Parameters<AgentStore["applyAvatarOnce"]>) {
		return this.visualChange(args[0], () => super.applyAvatarOnce(...args));
	}
	override applyManualAvatarOnce(
		...args: Parameters<AgentStore["applyManualAvatarOnce"]>
	) {
		return this.visualChange(args[0], () =>
			super.applyManualAvatarOnce(...args),
		);
	}
}
export class FleetLifeModels extends ModelSettingsStore {
	constructor(
		path: string,
		private readonly changed: () => void,
	) {
		super(path);
	}
	override replace(...args: Parameters<ModelSettingsStore["replace"]>) {
		const result = super.replace(...args);
		this.changed();
		return result;
	}
}
