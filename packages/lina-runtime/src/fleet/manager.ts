import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConversationStore } from "../../../lina-core/src/agents/conversation.ts";
import { AgentStore } from "../../../lina-core/src/agents/store.ts";
import type { AgentInput } from "../../../lina-core/src/agents/types.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import { DialogueStore } from "../../../lina-core/src/onboarding/dialogue-store.ts";
import { OnboardingStore } from "../../../lina-core/src/onboarding/store.ts";
import { HonchoClient } from "../../../lina-memory/src/honcho/client.ts";
import { validateHonchoConfig } from "../../../lina-memory/src/honcho/config.ts";
import {
	type HonchoConfig,
	HonchoRequestError,
} from "../../../lina-memory/src/honcho/types.ts";
import { boundWorkspace } from "../installation.ts";
import type { ModelControl } from "../models/port.ts";
import { ModelSettingsStore } from "../models/settings.ts";
import { splitPolicy } from "../policy/response.ts";
import type { AppOptions, startPersistentApp } from "../session-app.ts";
import { readPresets } from "./presets.ts";
export const validAgentId = (id: string) => /^[a-z][a-z0-9-]{0,47}$/.test(id);
type App = Awaited<ReturnType<typeof startPersistentApp>>;
export class AgentFleet {
	readonly onboarding: OnboardingStore;
	private readonly introductionShutdown = new AbortController();
	private readonly introductionRequests = new Set<Promise<void>>();
	beginIntroduction() {
		if (this.closed || this.closing) throw Error("Fleet is closed");
		const done = Promise.withResolvers<void>();
		this.introductionRequests.add(done.promise);
		return {
			signal: this.introductionShutdown.signal,
			finish: () => {
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
		input: Parameters<NonNullable<ModelControl["authoring"]>>[0],
		signal: AbortSignal,
	) {
		if (this.closing || this.closed) throw Error("Fleet is closed");
		const control =
			this.options.modelControl ??
			[...this.ready.values()]
				.map((app) => app.runtime.native.models)
				.find((c) => c?.authoring);
		if (!control?.authoring) throw Error("Authoring model unavailable");
		return control.authoring(input, signal);
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
			memoryBackend?: AppOptions["memoryBackend"];
			honchoClientOptions?: AppOptions["honchoClientOptions"];
			contextBudget?: number;
			approvalMode?: AppOptions["approvalMode"];
			importSession?: string;
			createApp?: (options: Omit<AppOptions, "engine">) => Promise<App>;
			modelControl?: ModelControl;
			ownsInstallation?: () => boolean;
		},
	) {
		this.root = checkedDirectory(resolve(options.stateRoot), true);
		realpathSync(this.root);
		this.agents = new AgentStore(join(this.root, "agents.sqlite"));
		this.conversations = new ConversationStore(
			join(this.root, "conversations.sqlite"),
		);
		this.modelSettings = new ModelSettingsStore(
			join(this.root, "models.sqlite"),
		);
		this.onboarding = new OnboardingStore(join(this.root, "onboarding.sqlite"));
		this.presets = readPresets(options.resourceRoot ?? options.workspace);
		if (!this.agents.get("lina")) {
			const seed = this.presets.find((p) => p.id === "lina");
			if (!seed) throw Error("Lina preset missing");
			this.agents.create(seed);
		}
	}
	memoryConfig(id: string): HonchoConfig | undefined {
		const base = this.options.honcho;
		if (
			this.options.memoryBackend === "native" ||
			this.options.memoryBackend === "disabled"
		)
			return;
		if (!base) return;
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
			port: 0,
			botId: id,
			persona: {
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
		if (config) appOptions.honcho = config;
		appOptions.memoryBackend =
			this.options.memoryBackend ?? (config ? "honcho" : "native");
		if (this.options.honchoClientOptions)
			appOptions.honchoClientOptions = this.options.honchoClientOptions;
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
				if (config) this.initializeMemory(id, app, config);
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
					(this.options.honcho ? "unavailable" : "disabled"),
			};
		});
	}
	async close() {
		if (this.closed) return;
		if (this.closing) return;
		this.closing = true;
		this.introductionShutdown.abort();
		await Promise.allSettled([...this.introductionRequests]);
		for (const item of this.memoryInit.values()) item.controller.abort();
		await Promise.allSettled(
			[...this.memoryInit.values()].map((item) => item.promise),
		);
		const failures: unknown[] = [];
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
		this.apps.clear();
		this.agents.close();
		this.conversations.close();
		this.modelSettings.close();
		this.onboarding.close();
		this.dialogueStore?.close();
		this.closed = true;
		this.closing = false;
	}
	private initializeMemory(id: string, app: App, config: HonchoConfig): void {
		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(10_000),
		]);
		const promise = (async () => {
			try {
				const client = new HonchoClient(
					config,
					this.options.honchoClientOptions,
				);
				const current = await client.check(signal).catch((error: unknown) => {
					if (error instanceof HonchoRequestError && error.status === 404)
						return { ok: false, missing: ["workspace"] };
					throw error;
				});
				if (!current.ok) await client.initialize(signal);
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
