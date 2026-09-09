import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import {
	checkedDirectory,
	readRegular,
	writeExclusive,
} from "../../../lina-core/src/attachments/filesystem.ts";
import { WorldStore } from "../../../lina-core/src/world/store.ts";
import { WorldAuthoring } from "../life/authoring.ts";
import type { LifeForeground } from "../life/runner.ts";
import { assertWorkSourceCurrent } from "../life/work-source.ts";
import type { ModelControl } from "../models/port.ts";
import type { ModelSettingsStore } from "../models/settings.ts";
import type { OrdinaryWorldSource } from "../world.ts";
import {
	type FleetLifeContext,
	type FleetLifeRuntime,
	fleetLifeIdentity,
} from "./life-runtime.ts";

export type LifeStorageHealth =
	| { state: "unopened" | "open" }
	| { state: "rejected"; code: "LIFE_STORAGE_UNAVAILABLE" };

/** Audit crash recovery/migrations on a private copy before touching existing bytes. */
function validateStoredLife(path: string, now?: () => number): void {
	if (!existsSync(path)) return;
	const suffixes = ["", "-wal", "-journal"];
	const stamp = () =>
		JSON.stringify(
			suffixes.map((suffix) => {
				const stat = lstatSync(path + suffix, { throwIfNoEntry: false });
				return stat
					? [suffix, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
					: [suffix, null];
			}),
		);
	const before = stamp();
	const temporary = mkdtempSync(join(tmpdir(), "lina-life-validation-"));
	try {
		for (const suffix of suffixes) {
			if (existsSync(path + suffix))
				writeExclusive(
					join(temporary, `world.sqlite${suffix}`),
					readRegular(path + suffix, Number.MAX_SAFE_INTEGER),
				);
		}
		if (stamp() !== before)
			throw Error("LIFE storage changed during validation");
		const probe = new WorldStore(join(temporary, "world.sqlite"), now);
		probe.close();
		if (stamp() !== before)
			throw Error("LIFE storage changed during validation");
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

class LifeStorageUnavailable extends Error {
	constructor() {
		super("LIFE_STORAGE_UNAVAILABLE");
	}
}

/** Lazily opens the installation database, and keeps native ownership until its drain succeeds. */
export class FleetLifeInstallation {
	private store: WorldStore | undefined;
	private service: WorldAuthoring | undefined;
	private background: FleetLifeRuntime | undefined;
	private rejected = false;
	constructor(
		private readonly options: {
			root: string;
			agents: AgentStore;
			modelSettings: ModelSettingsStore;
			foreground: LifeForeground;
			ownsInstallation(): boolean;
			assertAuthoring(): void;
			authoring: NonNullable<ModelControl["authoring"]>;
			createRuntime?: (context: FleetLifeContext) => FleetLifeRuntime;
			personalGrowth?: (
				store: WorldStore,
				worldId: string,
				agentId: string,
			) => ReturnType<NonNullable<FleetLifeContext["personalGrowth"]>>;
			now?: () => number;
		},
	) {}
	/** Recorded outcome only: health reads must not open optional owners. */
	get health(): LifeStorageHealth {
		if (!this.options.ownsInstallation())
			throw Error("Installation ownership required");
		return this.rejected
			? { state: "rejected", code: "LIFE_STORAGE_UNAVAILABLE" }
			: { state: this.store ? "open" : "unopened" };
	}
	/** Feed/storage access cannot create the scheduler, native model owner or authoring service. */
	get storage(): WorldStore {
		this.options.assertAuthoring();
		if (this.rejected) throw new LifeStorageUnavailable();
		if (!this.store) {
			try {
				const root = checkedDirectory(join(this.options.root, "life"), true);
				validateStoredLife(join(root, "world.sqlite"), this.options.now);
				this.store = new WorldStore(
					join(root, "world.sqlite"),
					this.options.now,
				);
			} catch {
				// WorldStore rolls back and closes a rejected open. Preserve the file
				// and memoize the failure until an explicit offline recovery/restart.
				this.rejected = true;
				throw new LifeStorageUnavailable();
			}
		}
		return this.store;
	}
	get authoring(): WorldAuthoring {
		const personalGrowth = this.options.personalGrowth;
		const store = this.storage;
		if (!this.service) {
			this.service = new WorldAuthoring({
				store,
				authoring: this.options.authoring,
				modelSettingsRevision: () =>
					this.options.modelSettings.snapshot().revision,
				agentExists: (id) => !!this.options.agents.get(id),
				changed: (worldId) => this.changed(worldId),
			});
		}
		if (
			!this.background &&
			this.options.ownsInstallation() &&
			this.options.createRuntime &&
			this.store
		) {
			this.background = this.options.createRuntime({
				...(personalGrowth
					? {
							personalGrowth: (worldId: string, agentId: string) =>
								personalGrowth(store, worldId, agentId),
						}
					: {}),
				store: this.store,
				agents: this.options.agents,
				modelSettings: this.options.modelSettings,
				foreground: this.options.foreground,
			});
			this.background.start();
		}
		return this.service;
	}
	get runtime(): FleetLifeRuntime {
		if (!this.options.ownsInstallation())
			throw Error("Installation ownership is required for LIFE runtime");
		void this.authoring;
		if (!this.background) throw Error("LIFE runtime unavailable");
		return this.background;
	}
	conversationSource(agentId: string): OrdinaryWorldSource | undefined {
		if (this.rejected) return;
		const personalGrowth = this.options.personalGrowth;
		if (
			!this.store &&
			existsSync(join(this.options.root, "life", "world.sqlite"))
		)
			try {
				void this.authoring;
			} catch (error) {
				if (error instanceof LifeStorageUnavailable) return;
				throw error;
			}
		const store = this.store;
		if (!store) return;
		const worldId = store.worldBinding(agentId)?.worldId;
		const limits = worldId
			? store.lifeConfig(worldId).limits?.evaluation
			: null;
		return {
			store,
			limits: limits
				? { maxChars: limits.maxChars, maxRecords: limits.maxRecords }
				: null,
			identityPolicy: () => {
				const selected = store.worldBinding(agentId)?.worldId;
				if (!selected) throw Error("Ordinary world is not bound");
				return fleetLifeIdentity(
					store,
					this.options.agents,
					selected,
					personalGrowth
						? (worldId, id) =>
								id === agentId
									? personalGrowth(store, worldId, id)
									: {
											agentId: id,
											worldId,
											personalBehavior: null,
											sourceStamp: null,
										}
						: undefined,
				).identity;
			},
			assertSourceCurrent: (selected) => {
				if (this.background) this.background.assertWorkCurrent(selected);
				else assertWorkSourceCurrent(undefined, store.workEvidence(selected));
			},
		};
	}
	resume() {
		if (
			this.options.ownsInstallation() &&
			existsSync(join(this.options.root, "life", "world.sqlite"))
		)
			try {
				void this.authoring;
			} catch (error) {
				if (!(error instanceof LifeStorageUnavailable)) throw error;
			}
	}
	changed(worldId?: string) {
		this.background?.changed(worldId);
	}
	publicationChanged() {
		this.background?.publicationChanged();
	}
	async drain() {
		await this.background?.close();
	}
	async closeAuthoring() {
		await this.service?.close();
	}
	closeStore() {
		this.store?.close();
	}
}
