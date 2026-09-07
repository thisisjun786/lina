import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { PermissionResolver } from "../../lina-runtime/src/approval-policy.ts";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import type { SessionPort } from "../../lina-runtime/src/sdk-port.ts";
import type { SessionEngine } from "../../lina-runtime/src/session-engine.ts";
import {
	eventsFromNotification,
	historyFromTurns,
	type ProjectedEntry,
	projectCodexItem,
	projectNotice,
} from "./events.ts";
import { CodexHost, jsonSchemaOf } from "./host.ts";
import {
	appendCodexJournal,
	commitCodexThread,
	initializeCodexSessionFile,
	inspectCodexSessionFile,
	loadCodexJournal,
	markCodexThreadPending,
	readCodexSessionHeader,
} from "./identity.ts";
import { conversationTurn } from "./model.ts";
import { type CodexRpc, type CodexRpcOptions, createCodexRpc } from "./rpc.ts";

export type CodexSessionOptions = SdkSessionOptions & {
	services: ContextServices;
	models: ModelControl;
	rpc?: CodexRpcOptions;
	rpcClient?: CodexRpc;
	skillRoots?: readonly string[];
	permissions?: PermissionResolver;
	model?: string;
	modelProvider?: string;
	notificationTimeoutMs?: number;
};

export type CodexEngineDefaults = {
	services: ContextServices;
	models: ModelControl;
	rpc?: CodexRpcOptions;
	skillRoots?: readonly string[];
	permissions?: PermissionResolver;
	model?: string;
	modelProvider?: string;
	notificationTimeoutMs?: number;
};

export type CodexSession = SessionPort & {
	readonly threadId: string;
	readonly skillNames: readonly string[];
};

type Waiter = {
	match: (method: string, params: unknown) => boolean;
	settle: (error?: Error, params?: unknown) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledSkills(raw: unknown): string[] {
	if (!isRecord(raw) || !Array.isArray(raw["data"])) return [];
	return raw["data"].flatMap((entry) => {
		if (!isRecord(entry) || !Array.isArray(entry["skills"])) return [];
		return entry["skills"].flatMap((skill) =>
			isRecord(skill) &&
			skill["enabled"] === true &&
			typeof skill["name"] === "string"
				? [skill["name"]]
				: [],
		);
	});
}

function threadIdOf(params: unknown): string | undefined {
	return isRecord(params) && typeof params["threadId"] === "string"
		? params["threadId"]
		: undefined;
}

function activeTurnId(thread: unknown): string | undefined {
	if (!isRecord(thread) || !isRecord(thread["status"])) return;
	if (thread["status"]["type"] !== "active" || !Array.isArray(thread["turns"]))
		return;
	const running = thread["turns"].find(
		(turn) =>
			isRecord(turn) &&
			turn["status"] === "inProgress" &&
			typeof turn["id"] === "string",
	);
	return isRecord(running) && typeof running["id"] === "string"
		? running["id"]
		: undefined;
}

function journalEntries(sessionFile: string): ProjectedEntry[] {
	return loadCodexJournal(sessionFile).flatMap((item) => {
		if (!isRecord(item) || typeof item["id"] !== "string") return [];
		if (item["type"] === "message" || item["type"] === "custom_message")
			return [item as ProjectedEntry];
		return [];
	});
}

function noticeId(
	entries: readonly unknown[],
	marker: { jobId: string; terminalRevision: number },
): string | null {
	for (const entry of entries) {
		if (
			!isRecord(entry) ||
			entry["type"] !== "custom_message" ||
			typeof entry["id"] !== "string"
		)
			continue;
		const details = isRecord(entry["details"]) ? entry["details"] : undefined;
		if (
			details?.["jobId"] === marker.jobId &&
			details["terminalRevision"] === marker.terminalRevision
		)
			return entry["id"];
	}
	return null;
}

function asError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback);
}

export async function createCodexSession(
	options: CodexSessionOptions,
): Promise<CodexSession> {
	const workspace = realpathSync(options.workspace);
	const identity = initializeCodexSessionFile(options.sessionFile, workspace);
	const rpc = options.rpcClient ?? (await createCodexRpc(options.rpc));
	const ownsRpc = !options.rpcClient;
	try {
		return await startSession(options, workspace, identity, rpc, ownsRpc);
	} catch (error) {
		if (ownsRpc) await rpc.close();
		throw error;
	}
}

async function startSession(
	options: CodexSessionOptions,
	workspace: string,
	identity: { sessionId: string; sessionFile: string },
	rpc: CodexRpc,
	ownsRpc: boolean,
): Promise<CodexSession> {
	const host = new CodexHost(
		workspace,
		options.permissions ??
			((name) => ({
				action: name === "bash" || name === "edit" ? "ask" : "allow",
			})),
	);
	const listeners = new Set<(event: unknown) => void>();
	const history: ProjectedEntry[] = [...journalEntries(identity.sessionFile)];
	const nativeItems = new Map<string, number>();
	const ordinals = new Map<string, number>();
	const remember = (entry: ProjectedEntry) => {
		if (entry.codex && entry.message) {
			nativeItems.set(
				`${entry.codex.turnId}:${entry.codex.nativeItemId}`,
				entry.codex.ordinal,
			);
			const key = `${entry.codex.turnId}:${entry.message.role}`;
			ordinals.set(
				key,
				Math.max(ordinals.get(key) ?? 0, entry.codex.ordinal + 1),
			);
		}
	};
	for (const entry of history) remember(entry);
	const retain = (entry: ProjectedEntry) => {
		if (history.some((item) => item.id === entry.id)) return false;
		appendCodexJournal(identity.sessionFile, entry);
		history.push(entry);
		remember(entry);
		return true;
	};
	const waiters = new Set<Waiter>();
	const waitTimeoutMs = options.notificationTimeoutMs ?? 30_000;
	// Native turns may pause for user approval or run lengthy tools. EOF, explicit
	// interruption and close settle them; elapsed wall time alone is not failure.
	const runTimeoutMs = options.notificationTimeoutMs ?? null;
	let closed = false;
	let ended = false;
	let boundThreadId: string | undefined;
	let boundModelProvider: string | undefined;
	let currentTurnId: string | undefined;
	let deliveredInstructions: string | undefined;
	let pendingStart = false;
	let liveSeq = 0;
	let runSeq = 0;
	let abortRequested = false;
	let aborting: Promise<void> | undefined;
	let turnReady: PromiseWithResolvers<string | undefined> | undefined;
	let turnAbort: AbortController | undefined;
	const settledTurnIds = new Set<string>();
	let tokens: number | null = null;
	let contextWindow: number | null = options.services.contextWindow;
	const skillNames: string[] = [];

	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};

	const waitNotification = (
		match: (method: string, params: unknown) => boolean,
		timeoutMs: number | null = waitTimeoutMs,
	): { promise: Promise<unknown>; cancel: (error?: Error) => void } => {
		let settled = false;
		let deliver: (error?: Error, params?: unknown) => void = () => undefined;
		const waiter: Waiter = {
			match,
			settle: (error, params) => deliver(error, params),
		};
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer =
				timeoutMs === null
					? undefined
					: setTimeout(() => {
							waiter.settle(
								new Error("Timed out waiting for Codex notification"),
							);
						}, timeoutMs);
			deliver = (error, params) => {
				if (settled) return;
				settled = true;
				waiters.delete(waiter);
				clearTimeout(timer);
				if (error) reject(error);
				else resolve(params);
			};
		});
		waiters.add(waiter);
		void promise.catch(() => undefined);
		return {
			promise,
			cancel: (error) => waiter.settle(error ?? new Error("Waiter cancelled")),
		};
	};

	const failWaiters = (error: Error): void => {
		for (const waiter of [...waiters]) waiter.settle(error);
	};

	const noteTurn = (turnId: string | undefined): void => {
		if (typeof turnId !== "string") return;
		if (closed || ended || liveSeq === 0) return;
		if (settledTurnIds.has(turnId)) return;
		currentTurnId = turnId;
		pendingStart = false;
		turnReady?.resolve(turnId);
	};

	const finalizeRun = (turnId?: string): void => {
		if (turnId) settledTurnIds.add(turnId);
		if (currentTurnId) settledTurnIds.add(currentTurnId);
		liveSeq = 0;
		currentTurnId = undefined;
		pendingStart = false;
		turnAbort?.abort();
		turnAbort = undefined;
		turnReady?.resolve(undefined);
	};

	const clearRun = (): void => {
		finalizeRun(currentTurnId);
	};

	const settleHost = (signal?: AbortSignal): void => {
		void host
			.emit(
				"agent_settled",
				{ type: "agent_settled" },
				signal ?? new AbortController().signal,
			)
			.catch((error: unknown) => {
				if (closed) return;
				emit({
					type: "continuation_error",
					errorMessage:
						error instanceof Error
							? error.message
							: "agent_settled hook failed",
				});
			});
	};

	const failRun = (error: Error): void => {
		const hadRun =
			currentTurnId !== undefined || pendingStart || waiters.size > 0;
		ended = true;
		clearRun();
		failWaiters(error);
		if (!hadRun || closed) return;
		emit({ type: "continuation_error", errorMessage: error.message });
		emit({ type: "agent_settled" });
		settleHost();
	};

	const unsubscribeRpc = rpc.subscribe((method, params) => {
		const source = threadIdOf(params);
		if (boundThreadId && source && source !== boundThreadId) return;
		if (method === "eof") {
			failRun(
				new Error(
					isRecord(params) && typeof params["message"] === "string"
						? params["message"]
						: "Codex RPC ended (EOF)",
				),
			);
			return;
		}
		if (
			method === "thread/compacted" ||
			(method === "item/completed" &&
				isRecord(params) &&
				isRecord(params["item"]) &&
				params["item"]["type"] === "contextCompaction")
		)
			deliveredInstructions = undefined;
		for (const waiter of [...waiters]) {
			if (waiter.match(method, params)) waiter.settle(undefined, params);
		}
		if (
			method === "turn/started" &&
			isRecord(params) &&
			isRecord(params["turn"])
		) {
			const id = params["turn"]["id"];
			if (typeof id === "string") noteTurn(id);
		}
		if (method === "turn/completed") {
			const turn =
				isRecord(params) && isRecord(params["turn"])
					? params["turn"]
					: undefined;
			const completedId =
				typeof turn?.["id"] === "string" ? turn["id"] : currentTurnId;
			finalizeRun(completedId);
			settleHost();
		}
		if (method === "thread/tokenUsage/updated" && isRecord(params)) {
			const usage = isRecord(params["tokenUsage"])
				? params["tokenUsage"]
				: undefined;
			const last = isRecord(usage?.["last"]) ? usage["last"] : undefined;
			if (typeof last?.["totalTokens"] === "number")
				tokens = last["totalTokens"];
			if (typeof usage?.["modelContextWindow"] === "number")
				contextWindow = usage["modelContextWindow"];
		}
		let projection: { turnId: string; ordinal: number } | undefined;
		if (method === "item/completed" && isRecord(params)) {
			const item = projectCodexItem(params["item"]);
			const turnId =
				typeof params["turnId"] === "string" ? params["turnId"] : currentTurnId;
			if (item?.message && turnId) {
				const key = `${turnId}:${item.message.role}`;
				projection = {
					turnId,
					ordinal:
						nativeItems.get(`${turnId}:${item.id}`) ?? ordinals.get(key) ?? 0,
				};
			}
		}
		for (const event of eventsFromNotification(method, params, projection)) {
			if (
				isRecord(event) &&
				event["type"] === "entry_appended" &&
				isRecord(event["entry"])
			) {
				if (!retain(event["entry"] as ProjectedEntry)) continue;
			}
			emit(event);
		}
	});

	const unsubscribeRequests = rpc.onRequest(async (method, params) => {
		const source = threadIdOf(params);
		if (boundThreadId && source && source !== boundThreadId) return;
		const signal = turnAbort?.signal;
		if (!signal) throw new Error("No active Codex turn for native request");
		if (method === "item/tool/call" && isRecord(params)) {
			const tool = typeof params["tool"] === "string" ? params["tool"] : "";
			const callId =
				typeof params["callId"] === "string" ? params["callId"] : randomUUID();
			return host.invokeTool(tool, callId, params["arguments"], signal);
		}
		if (
			method === "item/commandExecution/requestApproval" &&
			isRecord(params)
		) {
			const allow = await host.authorizeNative(
				"bash",
				typeof params["itemId"] === "string" ? params["itemId"] : randomUUID(),
				{ command: params["command"], cwd: params["cwd"] },
				signal,
			);
			return { decision: allow ? "accept" : "decline" };
		}
		if (method === "item/fileChange/requestApproval" && isRecord(params)) {
			const allow = await host.authorizeNative(
				"edit",
				typeof params["itemId"] === "string" ? params["itemId"] : randomUUID(),
				{ reason: params["reason"] },
				signal,
			);
			return { decision: allow ? "accept" : "decline" };
		}
	});

	const abortActiveTurn = async (waitForSettle = true): Promise<void> => {
		abortRequested = true;
		turnAbort?.abort();
		if (aborting) return aborting;
		aborting = (async () => {
			if (!currentTurnId && pendingStart && turnReady) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([
						turnReady.promise,
						new Promise<undefined>((resolve) => {
							timer = setTimeout(() => resolve(undefined), waitTimeoutMs);
						}),
					]);
				} catch {
					return;
				} finally {
					if (timer !== undefined) clearTimeout(timer);
				}
			}
			if (!currentTurnId || !boundThreadId) return;
			const done = waitNotification(
				(method) => method === "turn/completed",
				waitTimeoutMs,
			);
			try {
				await rpc.request("turn/interrupt", {
					threadId: boundThreadId,
					turnId: currentTurnId,
				});
				if (waitForSettle) await done.promise;
				else done.cancel(new Error("Codex session is closed"));
			} catch (error) {
				done.cancel(asError(error, "Codex interrupt failed"));
				if (waitForSettle) throw asError(error, "Codex interrupt failed");
			}
		})().finally(() => {
			aborting = undefined;
		});
		return aborting;
	};

	try {
		await rpc.request("initialize", {
			clientInfo: { name: "lina", title: "Lina", version: "0.1.0" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		rpc.notify("initialized");
		const catalog = await rpc.request("model/list", {});

		if (options.skillRoots?.length) {
			await rpc.request("skills/extraRoots/set", {
				extraRoots: [...options.skillRoots],
			});
		}
		const listed = await rpc.request("skills/list", {
			cwds: [workspace],
			forceReload: true,
		});
		skillNames.push(...enabledSkills(listed));
		options.register?.(host.asLinaHost(), options.services, host.permissions);

		const initial = conversationTurn(options, catalog);
		const header = readCodexSessionHeader(identity.sessionFile, workspace);
		let threadId = header.nativeThreadId;
		if (threadId) {
			const resumed = await rpc.request<{
				thread?: { id?: string; turns?: unknown; modelProvider?: string };
			}>("thread/resume", { threadId });
			if (resumed.thread?.id !== threadId)
				throw new Error("Codex resume did not return the bound native thread");
			boundModelProvider =
				typeof resumed.thread.modelProvider === "string"
					? resumed.thread.modelProvider
					: initial.modelProvider;
			for (const entry of historyFromTurns(resumed.thread?.turns))
				retain(entry);
		} else {
			markCodexThreadPending(identity.sessionFile, workspace);
			const started = await rpc.request<{
				thread: { id: string; path?: string | null };
			}>("thread/start", {
				cwd: workspace,
				model: initial.model,
				modelProvider: initial.modelProvider,
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
				personality: "none",
				historyMode: "legacy",
				developerInstructions: options.systemPrompt,
				dynamicTools: [...host.tools.values()].map((tool) => ({
					type: "function",
					name: tool.name,
					description: tool.description,
					inputSchema: jsonSchemaOf(tool.parameters),
				})),
			});
			threadId = started.thread.id;
			deliveredInstructions = options.systemPrompt;
			boundModelProvider = initial.modelProvider;
			commitCodexThread(
				identity.sessionFile,
				workspace,
				threadId,
				started.thread.path ?? undefined,
			);
			try {
				await rpc.request("thread/name/set", {
					threadId,
					name: `lina:${identity.sessionId}`,
				});
			} catch {
				/* native id is already bound; rename is best-effort persistence */
			}
		}
		boundThreadId = threadId;
		const read = await rpc.request<{ thread?: unknown }>("thread/read", {
			threadId: boundThreadId,
			includeTurns: true,
		});
		for (const entry of historyFromTurns(
			isRecord(read.thread) ? read.thread["turns"] : undefined,
		))
			retain(entry);
		currentTurnId = activeTurnId(read.thread);
		if (currentTurnId) turnAbort = new AbortController();
		if (
			!boundModelProvider &&
			isRecord(read.thread) &&
			typeof read.thread["modelProvider"] === "string"
		)
			boundModelProvider = read.thread["modelProvider"];
	} catch (error) {
		unsubscribeRpc();
		unsubscribeRequests();
		failWaiters(asError(error, "Codex session failed to start"));
		throw error;
	}

	if (!boundThreadId)
		throw new Error("Codex session is missing a native thread");

	const session: CodexSession = {
		sessionId: identity.sessionId,
		sessionFile: identity.sessionFile,
		models: options.models,
		threadId: boundThreadId,
		skillNames,
		history: () => history,
		hasActiveRun: () => !closed && !ended && currentTurnId !== undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		async prompt(text, admission) {
			admission.signal.throwIfAborted();
			const catalog = await rpc.request("model/list", {});
			const selected = conversationTurn(options, catalog, boundModelProvider);
			const prepared = await host.beforeTurn(text, admission.signal);
			admission.signal.throwIfAborted();
			const additionalContext: Record<string, { value: string; kind: string }> =
				{};
			if (prepared.context)
				additionalContext["lina-context-reference"] = {
					value: prepared.context,
					kind: "untrusted",
				};
			turnAbort = new AbortController();
			abortRequested = admission.signal.aborted;
			runSeq += 1;
			liveSeq = runSeq;
			pendingStart = true;
			turnReady = Promise.withResolvers();
			const onAbort = (): void => {
				void abortActiveTurn();
			};
			admission.signal.addEventListener("abort", onAbort);
			const done = waitNotification(
				(method) => method === "turn/completed",
				runTimeoutMs,
			);
			try {
				try {
					// collaborationMode can persist a custom prompt without rendering it
					// into model input. Deliver the complete snapshot as a developer item.
					const instructions = prepared.systemPrompt ?? options.systemPrompt;
					if (instructions !== deliveredInstructions) {
						await rpc.request(
							"thread/inject_items",
							{
								threadId: boundThreadId,
								items: [
									{
										type: "message",
										role: "developer",
										content: [
											{
												type: "input_text",
												text:
													"[Current Lina instruction snapshot]\nThis complete snapshot replaces earlier Lina instruction snapshots. Apply only its current persona, shared user context and first-reply state; omitted earlier guidance is no longer active. It does not change host permissions or authorize tools.\n\n" +
													instructions,
											},
										],
									},
								],
							},
							admission.signal,
						);
						deliveredInstructions = instructions;
					}
					admission.signal.throwIfAborted();
					const started = await rpc.request<{ turn?: { id?: string } }>(
						"turn/start",
						{
							threadId: boundThreadId,
							input: [{ type: "text", text, text_elements: [] }],
							model: selected.model,
							...(selected.effort ? { effort: selected.effort } : {}),
							...(Object.keys(additionalContext).length
								? { additionalContext }
								: {}),
						},
					);
					const startedId =
						typeof started.turn?.id === "string" ? started.turn.id : undefined;
					if (startedId) noteTurn(startedId);
					else {
						pendingStart = false;
						turnReady.resolve(currentTurnId);
					}
					if (
						!ended &&
						!closed &&
						!admission.signal.aborted &&
						(currentTurnId !== undefined ||
							(startedId !== undefined && settledTurnIds.has(startedId)))
					)
						admission.disposition("started");
				} catch (error) {
					pendingStart = false;
					turnReady.resolve(undefined);
					done.cancel(asError(error, "Codex turn/start failed"));
					clearRun();
					if (!admission.signal.aborted) admission.rejected();
					throw asError(error, "Codex turn/start failed");
				}
				if (abortRequested || admission.signal.aborted) await abortActiveTurn();
				await done.promise;
				admission.signal.throwIfAborted();
			} finally {
				admission.signal.removeEventListener("abort", onAbort);
				pendingStart = false;
			}
		},
		async abort() {
			await abortActiveTurn();
		},
		clearQueue() {
			undefined;
		},
		async compact() {
			const done = waitNotification(
				(method, params) =>
					method === "thread/compacted" ||
					(method === "item/completed" &&
						isRecord(params) &&
						isRecord(params["item"]) &&
						params["item"]["type"] === "contextCompaction"),
				runTimeoutMs,
			);
			try {
				await rpc.request("thread/compact/start", { threadId: boundThreadId });
			} catch (error) {
				done.cancel(asError(error, "Codex compact failed"));
				throw asError(error, "Codex compact failed");
			}
			return done.promise;
		},
		usage() {
			return { tokens, contextWindow };
		},
		async appendNotice(marker, text) {
			if (currentTurnId) return null;
			const existing = noticeId(
				[...history, ...loadCodexJournal(identity.sessionFile)],
				marker,
			);
			if (existing) return existing;
			const entry = projectNotice(`notice-${randomUUID()}`, text, marker);
			appendCodexJournal(identity.sessionFile, entry);
			history.push(entry);
			emit({ type: "entry_appended", entry });
			return entry.id;
		},
		async close() {
			if (closed) return;
			closed = true;
			ended = true;
			try {
				if (currentTurnId || pendingStart) {
					try {
						await abortActiveTurn(false);
					} catch {
						/* still finish close */
					}
				}
			} finally {
				clearRun();
				failWaiters(new Error("Codex session is closed"));
				unsubscribeRpc();
				unsubscribeRequests();
				listeners.clear();
				try {
					await host.emit(
						"agent_settled",
						{ type: "agent_settled" },
						new AbortController().signal,
					);
				} catch {
					/* close still finishes if a settled hook fails */
				}
				if (ownsRpc) await rpc.close();
			}
		},
	};
	return session;
}

export function createCodexEngine(
	defaults: CodexEngineDefaults,
): SessionEngine {
	return {
		kind: "codex",
		inspect: inspectCodexSessionFile,
		initialize: initializeCodexSessionFile,
		create: (options) => createCodexSession({ ...defaults, ...options }),
	};
}
