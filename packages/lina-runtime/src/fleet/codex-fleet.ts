import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createWorldAuthorEngine } from "../../../lina-codex/src/author-capabilities.ts";
import { type CodexRpc, createCodexRpc } from "../../../lina-codex/src/rpc.ts";
import { createCodexEngine } from "../../../lina-codex/src/session.ts";
import { TaskManager } from "../../../lina-codex/src/tasks.ts";
import { checkedDirectory } from "../../../lina-core/src/attachments/filesystem.ts";
import { acquireInstallationLock } from "../../../lina-core/src/installation/lock.ts";
import { parseHonchoEnv } from "../../../lina-memory/src/honcho/index.ts";
import {
	OpenVikingClient,
	parseOpenVikingEnv,
} from "../../../lina-memory/src/openviking/index.ts";
import { OpenCodexHub } from "../../../lina-opencodex/src/index.ts";
import { parseApprovalMode } from "../approval-policy.ts";
import { codexAssistantPrompt } from "../codex-prompt.ts";
import { parseMemoryBackend } from "../context/backend.ts";
import { createWorldAuthorSession } from "../life/author-session.ts";
import { resolveProfile } from "../models/selection.ts";
import { type AppOptions, startPersistentApp } from "../session-app.ts";
import { createCodexTaskTools } from "../tools/codex-tasks.ts";
import { workTools } from "../tools/work-memory.ts";
import { provisionCodexHome } from "./codex-home.ts";
import { hubRoutes } from "./hub-routes.ts";
import { AgentFleet, validAgentId } from "./manager.ts";
import { startFleetServer } from "./server.ts";
import { createSharedCodexRpc } from "./shared-codex-rpc.ts";
import { taskConnectionSpec } from "./task-connection.ts";
import { taskRoutes } from "./task-routes.ts";
import { createTaskTransport } from "./task-transport.ts";

export type CodexFleetOptions = {
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
				shutdown ??= app.stop().then(() => {
					locked = false;
					lock.close();
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
	const honcho = memoryBackend === "honcho" ? parseHonchoEnv(env) : undefined;
	const approvalMode = parseApprovalMode(env["LINA_APPROVAL_MODE"]);
	const hub = new OpenCodexHub({ env, homeDir: home });
	await hub.refresh().catch(() => undefined);
	const work = new OpenVikingClient(parseOpenVikingEnv(env));
	const workbench = workTools(work);
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
	const tasks = new TaskManager({
		path: join(stateRoot, "tasks.sqlite"),
		rpc: transport,
		dynamicTools: workbench.map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters,
		})),
		async executeTool(name, callId, args, signal) {
			const tool = workbench.find((tool) => tool.name === name);
			if (!tool || !args || typeof args !== "object" || Array.isArray(args))
				throw Error("Invalid work memory tool input");
			const result = await tool.execute(
				callId,
				args as Record<string, unknown>,
				signal,
			);
			return {
				contentItems: result.content.map((item) => ({
					type: "inputText" as const,
					text: item.text,
				})),
				success:
					result.details["service"] !== "unavailable" &&
					result.details["service"] !== "disabled",
			};
		},
	});
	let fleet: AgentFleet;
	const getSettings = () => fleet.modelSettings.snapshot();
	const modelControl = hub.createModelControl(getSettings);
	const subscriptions: (() => void)[] = [];
	let stopped = false;
	const validOwner = (id: string) => validAgentId(id) && !!fleet.agents.get(id);
	try {
		fleet = new AgentFleet({
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
			...(honcho ? { honcho } : {}),
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
							for (const tool of workbench) host.registerTool(tool);
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
	} catch (error) {
		await tasks.close();
		await transport.close();
		throw error;
	}
	void tasks.restore().catch(() => undefined);
	tasks.setNotifier(async (marker, text) => {
		const task = tasks.list().find((item) => item.id === marker.jobId);
		const app = task ? fleet.opened(task.ownerAgentId) : undefined;
		return app ? app.runtime.native.appendNotice(marker, text) : null;
	});
	let server: Awaited<ReturnType<typeof startFleetServer>>;
	try {
		server = await startFleetServer(fleet, port, resourceRoot, botId, {
			lazy: true,
			route: async (request, json) =>
				(await hubRoutes(request, hub, json)) ??
				taskRoutes(request, tasks, validOwner, json),
		});
	} catch (error) {
		await tasks.close();
		await transport.close();
		await fleet.close();
		throw error;
	}
	return {
		port: server.port,
		fleet,
		hub,
		tasks,
		async stop() {
			if (stopped) return;
			stopped = true;
			for (const off of subscriptions.splice(0)) off();
			await tasks.close();
			await transport.close();
			await server.stop();
		},
	};
}
