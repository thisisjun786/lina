import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import { WorldStore } from "../../../lina-core/src/world/store.ts";
import { WorldAuthoring } from "../life/authoring.ts";
import type { LifeForeground } from "../life/runner.ts";
import type { ModelControl } from "../models/port.ts";
import type { ModelSettingsStore } from "../models/settings.ts";
import type { FleetLifeContext, FleetLifeRuntime } from "./life-runtime.ts";

/** Lazily opens the installation database, and keeps native ownership until its drain succeeds. */
export class FleetLifeInstallation {
	private store: WorldStore | undefined;
	private service: WorldAuthoring | undefined;
	private background: FleetLifeRuntime | undefined;
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
			now?: () => number;
		},
	) {}
	get authoring(): WorldAuthoring {
		this.options.assertAuthoring();
		if (!this.service) {
			const root = checkedDirectory(join(this.options.root, "life"), true);
			this.store ??= new WorldStore(
				join(root, "world.sqlite"),
				this.options.now,
			);
			this.service = new WorldAuthoring({
				store: this.store,
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
	resume() {
		if (
			this.options.ownsInstallation() &&
			existsSync(join(this.options.root, "life", "world.sqlite"))
		)
			void this.authoring;
	}
	changed(worldId?: string) {
		this.background?.changed(worldId);
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
