import {
	closeSync,
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { ConversationStore } from "../../lina-core/src/agents/conversation.ts";
import type { AgentStore } from "../../lina-core/src/agents/store.ts";
import { AttachmentStore } from "../../lina-core/src/attachments/store.ts";
import { ContextStore } from "../../lina-core/src/context/index.ts";
import {
	ApprovalGate,
	ControlStore,
} from "../../lina-core/src/control/index.ts";
import {
	acquireSessionLease,
	acquireTranscriptLease,
	type BotBinding,
	DurableStore,
} from "../../lina-core/src/index.ts";
import type {
	HonchoClientOptions,
	HonchoConfig,
} from "../../lina-memory/src/honcho/index.ts";
import { type ApprovalMode, parseApprovalMode } from "./approval-policy.ts";
import { ContextChannel } from "./context/channel.ts";
import { CompanionMemory } from "./context/companion.ts";
import { ContextCoordinator } from "./context/coordinator.ts";
import { ExternalContext } from "./context/external.ts";
import { installContextHooks } from "./context/hooks.ts";
import { MemoryBridge } from "./context/memory.ts";
import { installMemoryQuery } from "./context/memory-query.ts";
import type { ContextServices } from "./context/port.ts";
import { createContextTools } from "./context/tools.ts";
import { startControlServer } from "./control-server.ts";
import { ExecutionCoordinator } from "./execution.ts";
import { installExecutionHooks } from "./execution-hooks.ts";
import type { LinaHost, SdkSessionOptions } from "./host.ts";
import { Ima2Client, type Ima2ClientOptions } from "./images/client.ts";
import { ImageJobs } from "./images/jobs.ts";
import { ImageJobStore } from "./images/store.ts";
import { createImageTools } from "./images/tools.ts";
import type { ModelSettings } from "./models/types.ts";
import { installPersona } from "./persona/hooks.ts";
import { nativePreferences } from "./persona/native-preferences.ts";
import { PersonaReflection } from "./persona/reflection.ts";
import { installResponsePolicy } from "./policy/hooks.ts";
import { ResponsePolicy } from "./policy/response.ts";
import { DurableRuntime } from "./runtime.ts";
import type { SessionPort } from "./sdk-port.ts";
import type { SessionEngine } from "./session-engine.ts";
import { createAttachmentTool } from "./tools/attachments.ts";
import { createNotepadTools } from "./tools/notepad.ts";
import { createStatusTool } from "./tools/status.ts";

export type AppOptions = {
	engine: SessionEngine;
	/** ima2 owns its server and credentials. false disables this optional adapter. */
	imageEngine?: Ima2ClientOptions | false;
	registerTools?: (host: LinaHost) => void;
	memoryBackend?: "native" | "honcho" | "disabled";
	modelSettings?: () => ModelSettings;
	persona?: {
		agents: AgentStore;
		agentId: string;
		conversations?: ConversationStore;
		userContext?: () => string;
		authoredContext?: () => string;
	};
	contextBudget?: number;
	approvalMode?: ApprovalMode;
	workspace: string;
	resourceRoot?: string;
	stateRoot: string;
	agentDir: string;
	systemPrompt: string;
	port: number;
	botId?: string;
	importSession?: string;
	honcho?: HonchoConfig;
	honchoClientOptions?: HonchoClientOptions;
	createSession?: (options: SdkSessionOptions) => Promise<SessionPort>;
};

export async function startPersistentApp(options: AppOptions) {
	const engine = options.engine;
	if (!engine || engine.kind !== "codex")
		throw Error("An explicit Codex engine is required");
	if (options.importSession)
		throw Error(
			"Legacy session import is no longer supported; existing data was not changed",
		);
	const responsePolicy = new ResponsePolicy(options.systemPrompt);
	const approvalMode = parseApprovalMode(options.approvalMode);
	const workspace = realpathSync(options.workspace),
		botId = options.botId ?? "lina";
	const lease = acquireSessionLease(options.stateRoot, botId, workspace);
	let transcriptLease: { close(): void } | undefined;
	let native: SessionPort | undefined,
		store: DurableStore | undefined,
		runtime: DurableRuntime | undefined;
	let server: ReturnType<typeof startControlServer> | undefined;
	let controls: ControlStore | undefined,
		execution: ExecutionCoordinator | undefined;
	let unsubscribeExecution: (() => void) | undefined;
	let contextStore: ContextStore | undefined,
		context: ContextCoordinator | undefined;
	let reflection: PersonaReflection | undefined;
	let refreshPersona: (() => string) | undefined;
	let memory: MemoryBridge | CompanionMemory | undefined,
		contextChannel: ContextChannel | undefined;
	const startedAt = new Date().toISOString();
	let lastAgentEndAt: string | undefined;
	let attachments: AttachmentStore | undefined;
	let images: ImageJobs | undefined;
	let stopped = false,
		stopping: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (stopping) return stopping;
		stopping = (async () => {
			await server?.stop();
			await images?.close();
			const reflectionClosing = reflection?.close();
			if (runtime) await runtime.close();
			else await native?.close();
			// Failed native shutdown retains ownership. A retry may finish cleanup.
			unsubscribeExecution?.();
			contextChannel?.close();
			await reflectionClosing;
			await memory?.close();
			context?.close();
			contextStore?.close();
			execution?.close();
			controls?.close();
			attachments?.close();
			store?.close();
			transcriptLease?.close();
			lease.close();
			stopped = true;
		})().catch((error: unknown) => {
			stopping = undefined;
			throw error;
		});
		return stopping;
	};
	try {
		const existing = lease.readBinding();
		const sessionFile =
			existing?.sessionFile ?? resolve(join(lease.root, "session.jsonl"));
		if (!existsSync(sessionFile)) {
			if (existing) throw new Error("The selected session file is missing");
			closeSync(openSync(sessionFile, "wx", 0o600));
		}
		engine.inspect(sessionFile, workspace);
		transcriptLease = acquireTranscriptLease(sessionFile, botId, workspace);
		const identity = await engine.initialize(sessionFile, workspace);
		if (existing && existing.sessionId !== identity.sessionId)
			throw new Error("The fixed session ID changed");
		const binding: BotBinding = { version: 1, botId, workspace, ...identity };
		lease.bind(binding);
		const attached = new AttachmentStore(lease.root, binding);
		attachments = attached;
		store = new DurableStore(join(lease.root, "state.sqlite"), binding);
		const journal = store;
		const storedContext = new ContextStore(
			join(lease.root, "context.sqlite"),
			binding,
			(id) => journal.entry(id),
		);
		contextStore = storedContext;
		let contextServices: ContextServices | undefined;
		const external = new ExternalContext(storedContext, journal, (...args) => {
			if (!contextServices) throw Error("Context model services unavailable");
			return contextServices.summarize(...args);
		});
		const contextCoordinator = new ContextCoordinator({
			external,
			nativeTokens: () => native?.usage().tokens ?? null,
			store: storedContext,
			busy: () => runtime?.snapshot().state !== "idle",
			compact: async () => {
				if (!native) throw new Error("Native session is unavailable");
				return native.compact();
			},
		});
		context = contextCoordinator;
		const useNative =
			(options.memoryBackend ?? (options.honcho ? "honcho" : "disabled")) ===
			"native";
		const memoryBridge = useNative
			? new CompanionMemory({
					path: join(lease.root, "mind.sqlite"),
					characterReference: () => {
						const p = options.persona?.agents.get(botId);
						return p
							? JSON.stringify({
									name: p.name,
									role: p.role,
									interests: p.interests,
									personality: p.personality,
									voice: p.voice,
								})
							: "";
					},
					allowCharacterGrowth: () =>
						!options.persona ||
						options.persona.agents.get(botId)?.evolution === "adaptive",
					binding,
					journal,
					onChange: () => contextChannel?.changed(),
				})
			: new MemoryBridge({
					path: join(lease.root, "honcho-outbox.sqlite"),
					binding,
					journal,
					...(options.memoryBackend !== "disabled" && options.honcho
						? { config: options.honcho }
						: {}),
					...(options.honchoClientOptions
						? { clientOptions: options.honchoClientOptions }
						: {}),
					onChange: () => contextChannel?.changed(),
				});
		memory = memoryBridge;
		controls = new ControlStore(join(lease.root, "control.sqlite"), binding);
		controls.recover();
		const coordinator = new ExecutionCoordinator({
			approvalMode,
			store: controls,
			gate: new ApprovalGate(controls),
			requestId: () => runtime?.currentRequestId(),
			runtimeState: () => ({
				cancelling: runtime?.isCancelling ?? false,
				cancelFailed: runtime?.cancelFailed ?? false,
				cancelRequestId: runtime?.cancelRequestId() ?? null,
			}),
		});
		execution = coordinator;
		if (options.imageEngine !== false) {
			images = new ImageJobs({
				store: new ImageJobStore(lease.root, binding),
				attachments: attached,
				client: new Ima2Client(options.imageEngine ?? {}),
				notify: (marker, text) =>
					native?.appendNotice(marker, text) ?? Promise.resolve(null),
			});
		}
		const imageJobs = images;
		native = await (options.createSession ?? engine.create)({
			workspace,
			sessionFile,
			agentDir: options.agentDir,
			systemPrompt: responsePolicy.sections.common,
			agentId: botId,
			...(options.modelSettings
				? { modelSettings: options.modelSettings }
				: {}),
			...(options.contextBudget
				? { contextBudget: options.contextBudget }
				: {}),
			register(host, services, permissions) {
				contextServices = services;
				options.registerTools?.(host);
				if (memoryBridge instanceof CompanionMemory && services.observe)
					memoryBridge.configure(
						services.observe,
						options.persona?.conversations && services.reflect
							? nativePreferences(
									options.persona.conversations,
									options.persona.agentId,
									journal,
									services.reflect,
								)
							: undefined,
					);
				if (memoryBridge instanceof CompanionMemory && services.reasonMemory)
					installMemoryQuery(
						host,
						memoryBridge.mind,
						journal,
						services.reasonMemory,
					);
				installResponsePolicy(host, responsePolicy);
				if (options.persona) {
					refreshPersona = installPersona(
						host,
						options.persona.agents,
						options.persona.agentId,
						responsePolicy.sections.common,
						services,
						{
							conversations: options.persona.conversations,
							userContext: options.persona.userContext,
							firstOrdinaryReply: () => !journal.hasNormalAssistantReply(),
							authoredContext: options.persona.authoredContext,
							memoryMode:
								useNative || options.honcho ? "automatic" : "disabled",
							nativeDynamics: useNative,
							...(memoryBridge instanceof CompanionMemory
								? { nativeState: () => memoryBridge.mind.state() }
								: {}),
						},
					);
					if (!useNative)
						reflection = new PersonaReflection({
							agents: options.persona.agents,
							agentId: options.persona.agentId,
							...(options.persona.conversations
								? { conversations: options.persona.conversations }
								: {}),
							journal,
							services,
							memory: memoryBridge,
							preferencesOnly: useNative,
						});
				}
				coordinator.configurePermissions(permissions);
				installExecutionHooks(host, coordinator);
				if (imageJobs)
					for (const tool of createImageTools(imageJobs, () =>
						runtime?.currentRequestId(),
					))
						host.registerTool(tool);
				host.registerTool(
					createAttachmentTool(
						attached,
						() => runtime?.currentRequestId(),
						services.analyzeImage,
					),
				);
				contextCoordinator.configure(services);
				installContextHooks(host, contextCoordinator, (query, signal) =>
					memoryBridge.recall(query, signal),
				);
				const tools = createContextTools(
					storedContext,
					journal,
					() => contextCoordinator.changed(),
					() => contextCoordinator.isBusy,
				);
				host.registerTool(tools.update);
				host.registerTool(tools.search);
				host.registerTool(tools.expand);
				const notepadRoot =
					options.persona || options.resourceRoot
						? join(lease.root, "notes")
						: join(workspace, "data");
				mkdirSync(notepadRoot, { recursive: true, mode: 0o700 });
				if (
					options.persona &&
					botId === "lina" &&
					!existsSync(join(notepadRoot, "notepad.md")) &&
					existsSync(join(options.resourceRoot ?? workspace, "data/notepad.md"))
				)
					copyFileSync(
						join(options.resourceRoot ?? workspace, "data/notepad.md"),
						join(notepadRoot, "notepad.md"),
						constants.COPYFILE_EXCL,
					);
				const notepad = createNotepadTools(notepadRoot);
				host.registerTool(notepad.read);
				host.registerTool(notepad.append);
				host.registerTool(
					createStatusTool(() => ({
						startedAt,
						workspace,
						interventionPort: server?.port ?? options.port,
						lastAgentEndAt,
						context: {
							working: storedContext.working(),
							activeSummary: contextCoordinator.state().activeId
								? storedContext.active()
								: null,
						},
					})),
				);
				host.on("agent_settled", () => {
					lastAgentEndAt = new Date().toISOString();
				});
			},
		});
		runtime = new DurableRuntime(native, store, binding, {
			beforeAbort: () => coordinator.abortAll(),
			beforeSubmit: () => {
				refreshPersona?.();
				if (contextCoordinator.isBusy)
					throw new Error("Wait for context compaction to finish");
			},
		});
		contextCoordinator.restore(native.history());
		const channel = new ContextChannel({
			runtime,
			coordinator: contextCoordinator,
			store: storedContext,
			memory: memoryBridge,
		});
		contextChannel = channel;
		unsubscribeExecution = runtime.subscribe((event) => {
			if (event.type === "snapshot") {
				coordinator.refresh();
				if (event.snapshot.state === "idle") {
					reflection?.settled();
					void imageJobs?.flushNotices().catch(() => {
						// The durable image job remains undelivered for recovery.
					});
				}
			}
		});
		server = startControlServer({
			runtime,
			execution: coordinator,
			context: channel,
			attachments: attached,
			port: options.port,
		});
		void channel.refresh();
		imageJobs?.resume();
		return {
			binding,
			runtime,
			context: channel,
			contextStore: storedContext,
			memory: memoryBridge,
			reflection,
			attachments: attached,
			images: imageJobs,
			execution: coordinator,
			port: server.port,
			stop,
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
