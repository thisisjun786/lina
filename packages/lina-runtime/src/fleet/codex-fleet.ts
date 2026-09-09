import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createWorldAuthorEngine } from "../../../lina-codex/src/author-capabilities.ts";
import type { createCodexLifeModel } from "../../../lina-codex/src/life-model.ts";
import { type CodexRpc, createCodexRpc } from "../../../lina-codex/src/rpc.ts";
import { createCodexEngine } from "../../../lina-codex/src/session.ts";
import type { TaskDynamicTool } from "../../../lina-codex/src/task-rpc.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import { acquireInstallationLock } from "../../../lina-core/src/installation/lock.ts";
import { WorldStore } from "../../../lina-core/src/world/store.ts";
import { OpenCodexHub } from "../../../lina-opencodex/src/index.ts";
import { parseApprovalMode } from "../approval-policy.ts";
import { codexAssistantPrompt } from "../codex-prompt.ts";
import { parseMemoryBackend } from "../context/backend.ts";
import {
	defaultEnginePolicy,
	EnginePolicySettingsStore,
} from "../context/policy-settings.ts";
import { Ima2Client } from "../images/client.ts";
import type { ImageClient } from "../images/jobs.ts";
import { createWorldAuthorSession } from "../life/author-session.ts";
import { systemLifeClock } from "../life/runtime.ts";
import type { LifeClock } from "../life/scheduler.ts";
import { assertWorkSourceCurrent } from "../life/work-source.ts";
import { resolveProfile } from "../models/selection.ts";
import { type AppOptions, startPersistentApp } from "../session-app.ts";
import { createCodexTaskTools } from "../tools/codex-tasks.ts";
import { workTools } from "../tools/work-memory.ts";
import { provisionCodexHome } from "./codex-home.ts";
import { enginePolicyRoutes } from "./companion-routes.ts";
import { hubRoutes } from "./hub-routes.ts";
import { FleetLifeImages } from "./life-images.ts";
import { createFleetLifeRuntime } from "./life-runtime.ts";
import { FleetLifeTasks } from "./life-runtime-tasks.ts";
import { AgentFleet, validAgentId } from "./manager.ts";
import { resourceRoutes } from "./resource-routes.ts";
import { FleetResources } from "./resource-runtime.ts";
import { startFleetServer } from "./server.ts";
import { createSharedCodexRpc } from "./shared-codex-rpc.ts";
import { taskConnectionSpec } from "./task-connection.ts";
import { taskRoutes } from "./task-routes.ts";
import { createTaskTransport } from "./task-transport.ts";

export type CodexFleetOptions = {
	enginePolicy?: AppOptions["enginePolicy"];
	workspace: string;
	resourceRoot?: string;
	workspaceRoot?: string;
	stateRoot?: string;
	port?: number;
	botId?: string;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	createTaskRpc?: () => Promise<CodexRpc>;
	defaultTaskMode?: "owned" | "shared";
	/** Trusted composition seam; never populated from HTTP or model arguments. */
	createWorldAuthorEngine?: typeof createWorldAuthorEngine;
	createLifeModel?: typeof createCodexLifeModel;
	/** Trusted deterministic transport seam; never accepted from HTTP or model tools. */
	createImageClient?: () => ImageClient;
	lifeClock?: LifeClock;
	createApp?: (
		options: Omit<AppOptions, "engine">,
	) => ReturnType<typeof startPersistentApp>;
};

export async function startCodexFleet(options: CodexFleetOptions) {
	const stateRoot = resolve(
		options.stateRoot ??
			(options.env ?? process.env)["LINA_STATE_DIR"] ??
			join(options.workspace, ".lina-codex-state"),
	);
	const lock = acquireInstallationLock(stateRoot);
	let locked = true;
	try {
		const app = await startUnlocked({ ...options, stateRoot }, () => locked);
		let shutdown: Promise<void> | undefined;
		return {
			...app,
			stop() {
				shutdown ??= app
					.stop()
					.then(() => {
						locked = false;
						lock.close();
					})
					.catch((error) => {
						shutdown = undefined;
						throw error;
					});
				return shutdown;
			},
		};
	} catch (error) {
		locked = false;
		lock.close();
		throw error;
	}
}

async function startUnlocked(
	options: CodexFleetOptions,
	ownsInstallation: () => boolean,
) {
	const env = options.env ?? process.env;
	const lifeClock = options.lifeClock;
	const home = options.homeDir ?? homedir();
	const workspace = resolve(options.workspace);
	const resourceRoot = resolve(options.resourceRoot ?? workspace);
	const stateRoot = checkedDirectory(
		resolve(
			options.stateRoot ??
				env["LINA_STATE_DIR"] ??
				join(workspace, ".lina-codex-state"),
		),
		true,
	);
	const botId = options.botId ?? env["LINA_BOT_ID"] ?? "lina";
	if (!validAgentId(botId)) throw Error("Invalid LINA_BOT_ID");
	const port = options.port ?? Number(env["LINA_INTERVENTION_PORT"] ?? 7979);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw Error("Invalid LINA_INTERVENTION_PORT");
	if (env["LINA_IMPORT_SESSION"])
		throw Error(
			"Codex mode does not import senpi transcripts. Use a new Lina state directory.",
		);
	const memoryBackend = parseMemoryBackend(env["LINA_MEMORY_BACKEND"]);
	const approvalMode = parseApprovalMode(env["LINA_APPROVAL_MODE"]);
	const hub = new OpenCodexHub({ env, homeDir: home });
	await hub.refresh().catch(() => undefined);
	const legacyTools = workTools();
	const resourceTools: TaskDynamicTool[] = legacyTools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		inputSchema: t.parameters,
	}));
	let resources: FleetResources | undefined;
	let resourceRejected = false;
	let resourceFailure: "invalid_storage" | "storage_unavailable" | null = null;
	let enginePolicyStore: EnginePolicySettingsStore | undefined;
	const getEnginePolicy = () =>
		options.enginePolicy?.() ??
		enginePolicyStore?.snapshot() ??
		defaultEnginePolicy();
	const taskSpec = taskConnectionSpec({
		stateRoot,
		homeDir: home,
		env,
		...(options.defaultTaskMode
			? { defaultMode: options.defaultTaskMode }
			: {}),
	});
	const transport = createTaskTransport(
		options.createTaskRpc ??
			(async () => {
				if (taskSpec.mode === "shared")
					return createSharedCodexRpc(taskSpec.socket);
				const connection = hub.isolatedHomeConnection();
				if (!connection || !hub.status().connected)
					throw Error("OpenCodex Hub is unavailable");
				const codexHome = provisionCodexHome(taskSpec.stateRoot, connection);
				return createCodexRpc({
					command: env["LINA_CODEX_COMMAND"] ?? "codex",
					cwd: workspace,
					env: { ...hub.childEnvironment(), CODEX_HOME: codexHome },
				});
			}),
		(_method, params) => {
			if (!params || typeof params !== "object" || !("threadId" in params))
				return false;
			return tasks.list().some((task) => task.threadId === params.threadId);
		},
	);
	const tasks = new FleetLifeTasks(
		{
			path: join(stateRoot, "tasks.sqlite"),
			rpc: transport,
			dynamicTools: resourceTools,
			executeTool(...args) {
				const legacy = legacyTools.find((t) => t.name === args[0]);
				if (legacy) legacy.execute(args[1], {}, args[3]);
				if (!resources) throw Error("Resource owner unavailable");
				return resources.executeTool(...args);
			},
		},
		() => fleet.lifeForeground,
	);
	let fleet: AgentFleet;
	let imageOwner: FleetLifeImages | undefined;
	const imageOptions = {
		...(env["LINA_IMA2_URL"] ? { baseUrl: env["LINA_IMA2_URL"] } : {}),
		serverFile:
			env["LINA_IMA2_SERVER_FILE"] ?? join(home, ".ima2", "server.json"),
	};
	const images = () => {
		if (!imageOwner)
			imageOwner = new FleetLifeImages({
				world: fleet.lifeStorage,
				agents: fleet.agents,
				root: stateRoot,
				clock: lifeClock ?? systemLifeClock,
				foreground: fleet.lifeForeground,
				assertInstallation() {
					if (!ownsInstallation())
						throw Error("Installation ownership required");
				},
				assertWorkCurrent: (worldId) =>
					fleet.assertPublicationSourceCurrent(worldId),
				createClient:
					options.createImageClient ?? (() => new Ima2Client(imageOptions)),
				changed: () => fleet.publicationChanged(),
			});
		return imageOwner;
	};
	const getSettings = () => fleet.modelSettings.snapshot();
	const modelControl = hub.createModelControl(getSettings);
	const subscriptions: (() => void)[] = [];
	let stopped = false;
	let fullyStopped = false;
	const validOwner = (id: string) => validAgentId(id) && !!fleet.agents.get(id);
	try {
		enginePolicyStore = new EnginePolicySettingsStore(
			join(stateRoot, "engine-policy.sqlite"),
		);
		fleet = new AgentFleet({
			enginePolicy: getEnginePolicy,
			workspace,
			resourceRoot,
			...(options.workspaceRoot
				? { workspaceRoot: options.workspaceRoot }
				: {}),
			stateRoot,
			agentDir: join(stateRoot, "codex-home"),
			systemPrompt: codexAssistantPrompt(
				readFileSync(join(resourceRoot, "data/app-system-prompt.md"), "utf8"),
			),
			memoryBackend,
			approvalMode,
			modelControl,
			ownsInstallation,
			assertLifeWorkCurrent: (snapshot) =>
				assertWorkSourceCurrent(tasks, snapshot, {
					current: (worldId, source) =>
						resources?.activities.current(
							resources.scope(null),
							worldId,
							source,
						) ?? false,
				}),
			...(lifeClock ? { lifeNow: () => lifeClock.now() } : {}),
			createLifeRuntime: (context) =>
				createFleetLifeRuntime({
					...context,
					images: images(),
					workSource: tasks,
					activitySource: {
						poll: (worldId) =>
							resources?.activityBridge(context.store).poll(worldId),
						current: (worldId, source) =>
							resources?.activities.current(
								resources.scope(null),
								worldId,
								source,
							) ?? false,
					},
					stateRoot,
					connection() {
						if (!ownsInstallation())
							throw Error("Installation ownership required");
						const connection = hub.isolatedHomeConnection();
						if (!connection || !hub.status().connected)
							throw Error("OpenCodex Hub is unavailable");
						return connection;
					},
					providerEnv: () => hub.childEnvironment(),
					...(options.createLifeModel
						? { createModel: options.createLifeModel }
						: {}),
					...(options.lifeClock ? { clock: options.lifeClock } : {}),
					...(env["LINA_CODEX_COMMAND"]
						? { command: env["LINA_CODEX_COMMAND"] }
						: {}),
				}),
			async createWorldAuthor(authorOptions) {
				const currentSelection = () => {
					authorOptions.service.assertScope({
						grantId: authorOptions.grant.id,
						grantRevision: authorOptions.grant.revision,
					});
					const connection = hub.isolatedHomeConnection();
					if (!connection || !hub.status().connected)
						throw Error("OpenCodex Hub is unavailable");
					const selected = resolveProfile(
						getSettings(),
						"conversation",
						authorOptions.grant.agentId,
					);
					if (!selected)
						throw Error(
							"Choose a guide-agent conversation model before opening the world author",
						);
					return { connection, selected };
				};
				const ready = await (
					options.createWorldAuthorEngine ?? createWorldAuthorEngine
				)({
					nativeRoot: join(authorOptions.stateRoot, "native"),
					grantId: authorOptions.grant.id,
					agentId: authorOptions.grant.agentId,
					worldId: authorOptions.grant.worldId,
					...currentSelection(),
					currentSelection,
					models: hub.createModelControl(
						getSettings,
						authorOptions.grant.agentId,
					),
					providerEnv: hub.childEnvironment(),
					...(env["LINA_CODEX_COMMAND"]
						? { command: env["LINA_CODEX_COMMAND"] }
						: {}),
				});
				return createWorldAuthorSession({ ...authorOptions, ...ready });
			},
			createApp:
				options.createApp ??
				(async (appOptions) => {
					const connection = hub.isolatedHomeConnection();
					if (!connection || !hub.status().connected)
						throw Error(
							"OpenCodex Hub is unavailable. Open model settings and refresh the connection.",
						);
					const selected = resolveProfile(
						getSettings(),
						"conversation",
						appOptions.botId,
					);
					if (!selected)
						throw Error(
							"Choose a conversation model in Lina model settings before opening the agent.",
						);
					const codexHome = provisionCodexHome(
						appOptions.stateRoot,
						connection,
					);
					const roots =
						env["LINA_CODEX_SKILL_ROOTS"]?.split(delimiter).filter(Boolean) ??
						[
							join(home, ".agents", "skills"),
							join(home, ".codex", "skills"),
						].filter(existsSync);
					const app = await startPersistentApp({
						...appOptions,
						imageEngine: imageOptions,
						engine: createCodexEngine({
							services: hub.createContextServices(
								getSettings,
								appOptions.botId,
								appOptions.systemPrompt,
							),
							models: hub.createModelControl(getSettings, appOptions.botId),
							modelProvider: "opencodex",
							skillRoots: roots,
							rpc: {
								command: env["LINA_CODEX_COMMAND"] ?? "codex",
								cwd: appOptions.workspace,
								env: { ...hub.childEnvironment(), CODEX_HOME: codexHome },
							},
						}),
						registerTools(host) {
							for (const tool of createCodexTaskTools(
								tasks,
								appOptions.botId ?? "lina",
								validOwner,
							))
								host.registerTool(tool);
							resources?.install(host, appOptions.botId ?? botId);
						},
					});
					subscriptions.push(
						app.runtime.subscribe((event) => {
							if (event.type === "snapshot" && event.snapshot.state === "idle")
								void tasks.flushNotices().catch(() => undefined);
						}),
					);
					queueMicrotask(() => {
						if (!stopped) void tasks.flushNotices().catch(() => undefined);
					});
					return app;
				}),
		});
		try {
			resources = new FleetResources({
				root: join(stateRoot, "resources"),
				limits: {
					maxFileBytes: 64 * 1024 * 1024,
					maxCatalogBytes: 64 * 1024 * 1024,
					maxExtractionBytes: 2 * 1024 * 1024,
				},
				services: () => hub.createContextServices(getSettings),
				policy: getEnginePolicy,
				validAgent: validOwner,
				isWorldParticipant: (worldId, agentId) => {
					const store = fleet.life.store;
					return (
						store instanceof WorldStore &&
						store.lifeDefinition(worldId).participants.includes(agentId)
					);
				},
				assertInstallation: () => {
					if (!ownsInstallation())
						throw Error("Installation ownership required");
				},
			});
		} catch (error) {
			resourceRejected = true;
			resourceFailure =
				error instanceof Error &&
				/corrupt|schema|reference/i.test(error.message)
					? "invalid_storage"
					: "storage_unavailable";
		}
		if (resources) resourceTools.push(...resources.dynamicTools());
	} catch (error) {
		await resources?.close();
		enginePolicyStore?.close();
		await tasks.close();
		await transport.close();
		throw error;
	}
	const updateForegroundTasks = () =>
		fleet.lifeForeground.set(
			tasks,
			tasks
				.list()
				.some(
					(task) => !["idle", "interrupted", "failed"].includes(task.status),
				),
		);
	updateForegroundTasks();
	subscriptions.push(tasks.subscribe(updateForegroundTasks));
	tasks.setNotifier(async (marker, text) => {
		const task = tasks.list().find((item) => item.id === marker.jobId);
		const app = task ? fleet.opened(task.ownerAgentId) : undefined;
		return app ? app.runtime.native.appendNotice(marker, text) : null;
	});
	let server: Awaited<ReturnType<typeof startFleetServer>> | undefined;
	try {
		// Source reconciliation settles before a retained world's runtime can start.
		await tasks.restore();
		const resourceOwner = resources,
			policyOwner = enginePolicyStore;
		if (!policyOwner) throw Error("Engine owners unavailable");
		server = await startFleetServer(fleet, port, resourceRoot, botId, {
			lazy: true,
			lifeImages: images,
			generatedAvatarAuthority: (authority) =>
				images().allowed(authority.candidate),
			generatedAvatarApplication: (candidate) => images().allowed(candidate),
			route: async (request, json) => {
				if (new URL(request.url).pathname === "/api/engines/status")
					return Response.json(
						{
							resources: resourceRejected
								? {
										state: "rejected",
										code: "RESOURCE_STORAGE_UNAVAILABLE",
										reason: resourceFailure,
									}
								: (resourceOwner?.status() ?? { state: "unavailable" }),
						},
						{ headers: { "Cache-Control": "no-store" } },
					);
				const policy = await enginePolicyRoutes(
					request,
					policyOwner,
					json,
					options.enginePolicy,
				);
				if (policy) return policy;
				const path = new URL(request.url).pathname,
					matched =
						/^\/api\/agents\/([a-z][a-z0-9-]{0,47})\/resources(?:\/|$)/.exec(
							path,
						);
				if (
					path === "/api/resources" ||
					path.startsWith("/api/resources/") ||
					matched
				) {
					const id = matched?.[1] ?? null;
					if (id && !validOwner(id))
						return Response.json({ error: "Unknown agent" }, { status: 404 });
					if (!resourceOwner)
						return Response.json(
							{ error: "RESOURCE_STORAGE_UNAVAILABLE" },
							{ status: 503 },
						);
					const client = resourceOwner.consumer(id);
					return resourceRoutes(request, {
						store: resourceOwner.engine.store,
						scope: client.scope,
						search: client.search,
						...(id ? { basePath: `/api/agents/${id}/resources` } : {}),
						onStored: (r) => resourceOwner.schedule(id, r.id),
					});
				}
				return (
					(await hubRoutes(request, hub, json)) ??
					taskRoutes(request, tasks, validOwner, json)
				);
			},
		});
		fleet.resumeLife();
	} catch (error) {
		await resources?.close();
		await server?.stop();
		await fleet.close();
		enginePolicyStore?.close();
		await tasks.close();
		await transport.close();
		throw error;
	}
	return {
		port: server.port,
		fleet,
		images,
		hub,
		tasks,
		async stop() {
			if (fullyStopped) return;
			stopped = true;
			fleet.lifeForeground.set("shutdown", true);
			for (const off of subscriptions.splice(0)) off();
			await resources?.close();
			await imageOwner?.close();
			// LIFE drains and detaches its work bridge while the source journal is still open.
			await server?.stop();
			await tasks.close();
			await transport.close();
			enginePolicyStore?.close();
			fullyStopped = true;
		},
	};
}
