import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConversationStore } from "../../../lina-core/src/agents/conversation.ts";
import type { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { AgentInput } from "../../../lina-core/src/agents/types.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import { DialogueStore } from "../../../lina-core/src/onboarding/dialogue-store.ts";
import { OnboardingStore } from "../../../lina-core/src/onboarding/store.ts";
import type { WorldStore } from "../../../lina-core/src/world/store.ts";
import type { WorkEvidenceSnapshot } from "../../../lina-core/src/world/work-types.ts";
import { HonchoClient } from "../../../lina-memory/src/honcho/client.ts";
import {
	selectHonchoConfig,
	validateHonchoConfig,
} from "../../../lina-memory/src/honcho/config.ts";
import {
	type HonchoConfig,
	HonchoRequestError,
	type QualifiedHonchoAdapter,
} from "../../../lina-memory/src/honcho/types.ts";
import { defaultEnginePolicy } from "../context/policy-settings.ts";
import { boundWorkspace } from "../installation.ts";
import type {
	WorldAuthorFactoryOptions,
	WorldAuthorSession,
} from "../life/author-session.ts";
import type { WorldAuthoring } from "../life/authoring.ts";
import { assertWorkSourceCurrent } from "../life/work-source.ts";
import type { ModelControl } from "../models/port.ts";
import type { ModelSettingsStore } from "../models/settings.ts";
import {
	growthSourcesCurrent,
	type PersonalGrowthSource,
} from "../persona/growth-source.ts";
import { openPersonaSourceOwner } from "../persona/source-owner.ts";
import { splitPolicy } from "../policy/response.ts";
import type { AppOptions, startPersistentApp } from "../session-app.ts";
import type { FleetLifeContext, FleetLifeRuntime } from "./life-runtime.ts";
import { FleetLifeAuthors } from "./life-runtime-authors.ts";
import { FleetLifeInstallation } from "./life-runtime-installation.ts";
import {
	FleetLifeAgents,
	FleetLifeForeground,
	FleetLifeModels,
} from "./life-runtime-state.ts";
import { readPresets } from "./presets.ts";
export const validAgentId = (id: string) => /^[a-z][a-z0-9-]{0,47}$/.test(id);
type App = Awaited<ReturnType<typeof startPersistentApp>>;
export class AgentFleet {
	private readonly personalSources = new Map<string, PersonalGrowthSource>();
	private readonly personalReaders = new Map<
		string,
		ReturnType<typeof openPersonaSourceOwner>
	>();
	private personalGrowth(store: WorldStore, worldId: string, agentId: string) {
		const empty = {
			agentId,
			worldId,
			personalBehavior: null,
			sourceStamp: null,
		};
		if (
			!(this.options.enginePolicy?.() ?? defaultEnginePolicy()).memory.enabled
		)
			return empty;
		if (
			!this.agents.behavior
				.status(agentId)
				.some((job) => job.worldId === worldId && job.state === "committed")
		)
			return empty;
		const profile = this.agents.get(agentId);
		if (!profile || profile.evolution === "manual") return empty;
		const definition = store.lifeDefinition(worldId);
		const registered = this.personalSources.get(agentId);
		const root =
			agentId === "lina" ? this.root : join(this.root, "agents", agentId);
		let owner = registered ? undefined : this.personalReaders.get(agentId);
		if (!registered && !owner) {
			owner = openPersonaSourceOwner({
				stateRoot: root,
				botId: agentId,
				workspace: this.options.workspaceRoot
					? join(this.options.workspaceRoot, agentId)
					: this.options.workspace,
			});
			this.personalReaders.set(agentId, owner);
		}
		const source =
			registered ??
			(owner
				? {
						mind: owner.mind(),
						lookup: (id: string) => owner.journal().sourceEntry(id),
					}
				: undefined);
		if (!source) throw Error("Personal source unavailable");
		return this.agents.behavior.current(agentId, worldId, (input) =>
			growthSourcesCurrent(source, input, profile, definition),
		);
	}
	private readonly lifeInstallation: FleetLifeInstallation;
	private readonly worldAuthors: FleetLifeAuthors;
	readonly lifeForeground = new FleetLifeForeground();
	get lifeRuntime(): FleetLifeRuntime {
		return this.lifeInstallation.runtime;
	}
	resumeLife() {
		this.lifeInstallation.resume();
	}
	get life(): WorldAuthoring {
		return this.lifeInstallation.authoring;
	}
	get lifeStorage() {
		return this.lifeInstallation.storage;
	}
	get lifeHealth() {
		return this.lifeInstallation.health;
	}
	assertPublicationSourceCurrent(worldId: string) {
		const snapshot = this.lifeStorage.workEvidence(worldId);
		if (this.options.assertLifeWorkCurrent)
			this.options.assertLifeWorkCurrent(snapshot);
		else assertWorkSourceCurrent(undefined, snapshot);
	}
	publicationChanged() {
		this.lifeInstallation.publicationChanged();
	}
	grantWorldAuthor(worldId: string, agentId: string) {
		if (!validAgentId(agentId) || !this.agents.get(agentId))
			throw Error("Unknown guide agent");
		return this.life.store.grantWorldAuthor(worldId, agentId);
	}
	openWorldAuthor(grantId: string) {
		return this.worldAuthors.open(grantId);
	}
	openedWorldAuthor(grantId: string) {
		return this.worldAuthors.opened(grantId);
	}
	revokeWorldAuthor(grantId: string, revision: number) {
		return this.worldAuthors.revoke(grantId, revision);
	}
	readonly onboarding: OnboardingStore;
	private readonly introductionShutdown = new AbortController();
	private readonly introductionRequests = new Set<Promise<void>>();
	beginIntroduction() {
		if (this.closed || this.closing) throw Error("Fleet is closed");
		const finishForeground = this.lifeForeground.begin();
		const done = Promise.withResolvers<void>();
		this.introductionRequests.add(done.promise);
		return {
			signal: this.introductionShutdown.signal,
			finish: () => {
				finishForeground();
				this.introductionRequests.delete(done.promise);
				done.resolve();
			},
		};
	}
	private dialogueStore: DialogueStore | undefined;
	get introductions(): DialogueStore {
		if (this.closed || this.closing) throw Error("Fleet is closed");
		if (!this.options.ownsInstallation?.() && !this.ready.has("lina"))
			throw Error("Primary session lease is required for introductions");
		this.dialogueStore ??= new DialogueStore(
			join(this.root, "introductions.sqlite"),
		);
		return this.dialogueStore;
	}
	onboardingBase(): string {
		return splitPolicy(this.options.systemPrompt).common;
	}
	async authoring(
		input: Parameters<NonNullable<ModelControl["authoring"]>>[0] & {
			/** Trusted caller guard; never part of model-visible prompt data. */
			beforeDispatch?: () => void;
		},
		signal: AbortSignal,
	) {
		if (this.closing || this.closed) throw Error("Fleet is closed");
		const control =
			this.options.modelControl ??
			[...this.ready.values()]
				.map((app) => app.runtime.native.models)
				.find((c) => c?.authoring);
		if (!control?.authoring) throw Error("Authoring model unavailable");
		const finish = this.lifeForeground.begin();
		try {
			signal.throwIfAborted();
			input.beforeDispatch?.();
			return await control.authoring(input, signal);
		} finally {
			finish();
		}
	}
	opened(id: string): App | undefined {
		return this.ready.get(id);
	}
	modelState() {
		const opened = [...this.ready.entries()];
		const catalog =
			this.options.modelControl?.catalog() ??
			opened
				.find(([, app]) => app.runtime.native.models)?.[1]
				.runtime.native.models?.catalog() ??
			[];
		return {
			agents: this.agents.list().map(({ id, name }) => ({ id, name })),
			settings: this.modelSettings.snapshot(),
			catalog,
			active: opened.flatMap(([agentId, app]) =>
				app.runtime.native.models
					? [{ agentId, ...app.runtime.native.models.state() }]
					: [],
			),
		};
	}
	managementModelControl(): ModelControl | undefined {
		return (
			this.options.modelControl ??
			[...this.ready.values()].find((app) => app.runtime.native.models)?.runtime
				.native.models
		);
	}
	readonly modelSettings: ModelSettingsStore;
	readonly agents: AgentStore;
	readonly conversations: ConversationStore;
	readonly presets: AgentInput[];
	readonly root: string;
	private readonly apps = new Map<string, Promise<App>>();
	private readonly ready = new Map<string, App>();
	private readonly memoryInit = new Map<
		string,
		{ controller: AbortController; promise: Promise<void> }
	>();
	private readonly stopped = new Set<App>();
	private closing = false;
	private shutdown: Promise<void> | undefined;
	private closed = false;
	constructor(
		private readonly options: {
			workspace: string;
			resourceRoot?: string;
			workspaceRoot?: string;
			stateRoot: string;
			agentDir: string;
			systemPrompt: string;
			honcho?: HonchoConfig;
			honchoByAgent?: Record<string, HonchoConfig>;
			qualifiedHonchoAdapter?: QualifiedHonchoAdapter;
			memoryBackend?: AppOptions["memoryBackend"];
			enginePolicy?: AppOptions["enginePolicy"];
			honchoClientOptions?: AppOptions["honchoClientOptions"];
			contextBudget?: number;
			approvalMode?: AppOptions["approvalMode"];
			importSession?: string;
			createApp?: (options: Omit<AppOptions, "engine">) => Promise<App>;
			createWorldAuthor?: (
				options: WorldAuthorFactoryOptions,
			) => Promise<WorldAuthorSession>;
			modelControl?: ModelControl;
			ownsInstallation?: () => boolean;
			createLifeRuntime?: (context: FleetLifeContext) => FleetLifeRuntime;
			assertLifeWorkCurrent?: (snapshot: WorkEvidenceSnapshot) => void;
			lifeNow?: () => number;
		},
	) {
		this.root = checkedDirectory(resolve(options.stateRoot), true);
		realpathSync(this.root);
		this.agents = new FleetLifeAgents(join(this.root, "agents.sqlite"), () =>
			this.lifeInstallation?.changed(),
		);
		this.agents.behavior.recover();
		this.conversations = new ConversationStore(
			join(this.root, "conversations.sqlite"),
		);
		this.modelSettings = new FleetLifeModels(
			join(this.root, "models.sqlite"),
			() => this.lifeInstallation?.changed(),
		);
		this.lifeInstallation = new FleetLifeInstallation({
			personalGrowth: (store, worldId, agentId) =>
				this.personalGrowth(store, worldId, agentId),
			root: this.root,
			agents: this.agents,
			modelSettings: this.modelSettings,
			foreground: this.lifeForeground,
			ownsInstallation: () => this.options.ownsInstallation?.() ?? false,
			assertAuthoring: () => {
				if (this.closed || this.closing) throw Error("Fleet is closed");
				if (!this.options.ownsInstallation?.() && !this.ready.has("lina"))
					throw Error("Installation ownership is required for world authoring");
			},
			authoring: (input, signal) => {
				if (!this.options.modelControl?.authoring)
					throw Error("Authoring model unavailable");
				return this.authoring(input, signal);
			},
			...(options.createLifeRuntime
				? { createRuntime: options.createLifeRuntime }
				: {}),
			...(options.lifeNow ? { now: options.lifeNow } : {}),
		});
		this.worldAuthors = new FleetLifeAuthors({
			root: this.root,
			agents: this.agents,
			modelSettings: this.modelSettings,
			foreground: this.lifeForeground,
			service: () => this.life,
			closing: () => this.closing || this.closed,
			...(options.createWorldAuthor
				? { create: options.createWorldAuthor }
				: {}),
		});
		this.onboarding = new OnboardingStore(join(this.root, "onboarding.sqlite"));
		this.presets = readPresets(options.resourceRoot ?? options.workspace);
		if (!this.agents.get("lina")) {
			const seed = this.presets.find((p) => p.id === "lina");
			if (!seed) throw Error("Lina preset missing");
			this.agents.create(seed);
		}
	}
	memoryConfig(id: string): HonchoConfig | undefined {
		if (
			this.options.memoryBackend === "native" ||
			this.options.memoryBackend === "disabled"
		)
			return;
		const explicit = Object.hasOwn(this.options.honchoByAgent ?? {}, id)
			? this.options.honchoByAgent?.[id]
			: undefined;
		if (
			explicit?.ordinaryNamespace &&
			explicit.ordinaryNamespace.ownerBotId !== id
		)
			throw Error("Honcho map key does not match namespace owner");
		const base = selectHonchoConfig(explicit ?? this.options.honcho, id);
		if (!base) return;
		if (base.ordinaryNamespace) return base;
		return validateHonchoConfig({
			...base,
			sessionId: `lina-${id}`,
			observerPeerId: `agent-${id}`,
		});
	}
	app(id: string): Promise<App> {
		if (this.closed || this.closing)
			return Promise.reject(Error("Fleet is closed"));
		if (!validAgentId(id) || !this.agents.get(id))
			return Promise.reject(Error("Unknown agent"));
		const existing = this.apps.get(id);
		if (existing) return existing;
		const stateRoot = checkedDirectory(
				id === "lina" ? this.root : join(this.root, "agents", id),
				true,
			),
			config = this.memoryConfig(id);
		const appOptions: Omit<AppOptions, "engine"> = {
			...(this.options.enginePolicy
				? { enginePolicy: this.options.enginePolicy }
				: {}),
			workspace: realpathSync(
				checkedDirectory(
					boundWorkspace(
						stateRoot,
						this.options.workspaceRoot
							? join(this.options.workspaceRoot, id)
							: this.options.workspace,
					),
					true,
				),
			),
			...(this.options.resourceRoot
				? { resourceRoot: this.options.resourceRoot }
				: {}),
			stateRoot,
			agentDir: this.options.agentDir,
			systemPrompt: this.options.systemPrompt,
			modelSettings: () => this.modelSettings.snapshot(),
			world: () => this.lifeInstallation.conversationSource(id),
			port: 0,
			botId: id,
			persona: {
				registerPersonalSource: (source) => {
					this.personalReaders.get(id)?.close();
					this.personalReaders.delete(id);
					this.personalSources.set(id, source);
					return () => {
						if (this.personalSources.get(id) === source)
							this.personalSources.delete(id);
					};
				},
				agents: this.agents,
				agentId: id,
				conversations: this.conversations,
				userContext: () => this.onboarding.userContextFor(id),
				authoredContext: () =>
					this.onboarding.authoredContextFor(
						id,
						this.agents.get(id)?.revision ?? 0,
					),
			},
		};
		// Keep a rejected global owner configured so MemoryBridge reports it as
		// unavailable. Missing qualification must not select a native backend.
		const requested = config ?? this.options.honcho;
		if (
			requested &&
			this.options.memoryBackend !== "native" &&
			this.options.memoryBackend !== "disabled"
		)
			appOptions.honcho = requested;
		appOptions.memoryBackend =
			this.options.memoryBackend ?? (requested ? "honcho" : "native");
		if (this.options.honchoClientOptions || this.options.qualifiedHonchoAdapter)
			appOptions.honchoClientOptions = {
				...this.options.honchoClientOptions,
				...(this.options.qualifiedHonchoAdapter
					? { qualifiedAdapter: this.options.qualifiedHonchoAdapter }
					: {}),
			};
		if (this.options.contextBudget !== undefined)
			appOptions.contextBudget = this.options.contextBudget;
		if (this.options.approvalMode !== undefined)
			appOptions.approvalMode = this.options.approvalMode;
		if (id === "lina" && this.options.importSession !== undefined)
			appOptions.importSession = this.options.importSession;
		if (!this.options.createApp)
			throw Error("A configured Codex app factory is required");
		const pending = this.options
			.createApp(appOptions)
			.then((app) => {
				this.ready.set(id, app);
				if (this.options.createLifeRuntime)
					this.lifeForeground.track(app.runtime);
				if (config) this.startMemoryInitialization(id, app, config);
				return app;
			})
			.catch((error) => {
				this.apps.delete(id);
				throw error;
			});
		this.apps.set(id, pending);
		return pending;
	}
	async forSession(sessionId: string): Promise<App | undefined> {
		for (const app of this.ready.values())
			if (app.binding.sessionId === sessionId) return app;
		for (const profile of this.agents.list()) {
			const binding = join(
				profile.id === "lina"
					? this.root
					: join(this.root, "agents", profile.id),
				"binding.json",
			);
			try {
				const value: unknown = JSON.parse(readFileSync(binding, "utf8"));
				if (
					value &&
					typeof value === "object" &&
					"sessionId" in value &&
					value.sessionId === sessionId
				)
					return this.app(profile.id);
			} catch {}
		}
		return;
	}
	summary() {
		return this.agents.list().map((profile) => {
			const app = this.ready.get(profile.id);
			return {
				...profile,
				dynamics: this.agents.dynamics(profile.id),
				state: app?.runtime.snapshot().state ?? "idle",
				sessionId: app?.binding.sessionId ?? null,
				memory:
					app?.memory.status().service ??
					(this.options.honcho || this.options.honchoByAgent?.[profile.id]
						? "unavailable"
						: "disabled"),
			};
		});
	}
	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		this.shutdown ??= this.closeOwned().catch((error) => {
			this.closing = false;
			this.shutdown = undefined;
			throw error;
		});
		return this.shutdown;
	}
	private async closeOwned() {
		this.closing = true;
		this.lifeForeground.set("shutdown", true);
		this.introductionShutdown.abort();
		await Promise.allSettled([...this.introductionRequests]);
		for (const item of this.memoryInit.values()) item.controller.abort();
		await Promise.allSettled(
			[...this.memoryInit.values()].map((item) => item.promise),
		);
		const failures: unknown[] = [];
		try {
			await this.lifeInstallation.drain();
		} catch (error) {
			failures.push(error);
		}
		failures.push(...(await this.worldAuthors.close()));
		await this.lifeInstallation.closeAuthoring();
		for (const pending of this.apps.values()) {
			let app: App;
			try {
				app = await pending;
			} catch {
				continue;
			}
			try {
				if (!this.stopped.has(app)) {
					await app.stop();
					this.stopped.add(app);
				}
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length) {
			this.closing = false;
			throw new AggregateError(
				failures,
				"One or more fleet children did not stop",
			);
		}
		this.ready.clear();
		for (const reader of this.personalReaders.values()) reader.close();
		this.personalReaders.clear();
		this.apps.clear();
		this.agents.close();
		this.conversations.close();
		this.modelSettings.close();
		this.onboarding.close();
		this.dialogueStore?.close();
		this.lifeForeground.close();
		this.lifeInstallation.closeStore();
		this.closed = true;
		this.closing = false;
	}
	async initializeMemory(id: string, signal: AbortSignal): Promise<boolean> {
		const config = this.memoryConfig(id);
		if (!config) return false;
		const app = await this.app(id);
		await this.memoryInit.get(id)?.promise;
		try {
			await this.checkMemoryInitialization(app, config, signal);
		} catch (error) {
			if (error instanceof HonchoRequestError && error.kind === "body")
				return false;
			throw error;
		}
		await app.memory.refresh();
		return true;
	}
	private async checkMemoryInitialization(
		app: App,
		config: HonchoConfig,
		signal: AbortSignal,
	) {
		const client = new HonchoClient(config, {
			...this.options.honchoClientOptions,
			...(this.options.qualifiedHonchoAdapter
				? { qualifiedAdapter: this.options.qualifiedHonchoAdapter }
				: {}),
			binding: app.binding,
			sourceLookup: (id) => app.runtime.store.sourceEntry(id),
		});
		if (config.ordinaryNamespace && !(await client.qualify(signal)))
			throw new HonchoRequestError(
				"Honcho namespace qualification unavailable",
				"body",
			);
		const current = await client.check(signal).catch((error: unknown) => {
			if (error instanceof HonchoRequestError && error.status === 404)
				return { ok: false, missing: ["workspace"] };
			throw error;
		});
		if (!current.ok) await client.initialize(signal);
	}
	private startMemoryInitialization(
		id: string,
		app: App,
		config: HonchoConfig,
	): void {
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(10_000),
		]);
		const promise = (async () => {
			try {
				await this.checkMemoryInitialization(app, config, signal);
				// MemoryBridge owns and cancels capture; init must not wait for a
				// large outbox before app.stop() gets the chance to close it.
				void app.memory.refresh();
			} catch {
			} finally {
				this.memoryInit.delete(id);
			}
		})();
		this.memoryInit.set(id, { controller, promise });
	}
}
