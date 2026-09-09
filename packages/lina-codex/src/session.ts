import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { PermissionResolver } from "../../lina-runtime/src/approval-policy.ts";
import type { ContextServices } from "../../lina-runtime/src/context/port.ts";
import type { SessionContextExposure } from "../../lina-runtime/src/context-policy.ts";
import type { SdkSessionOptions } from "../../lina-runtime/src/host.ts";
import type { ModelControl } from "../../lina-runtime/src/models/port.ts";
import type { SessionPort } from "../../lina-runtime/src/sdk-port.ts";
import type { SessionEngine } from "../../lina-runtime/src/session-engine.ts";
import { worldAuthorCapability } from "./author-capabilities.ts";
import {
	CodexContextPolicy,
	validateContextOptions,
} from "./context-policy.ts";
import {
	eventsFromNotification,
	historyFromTurns,
	type ProjectedEntry,
	projectCodexItem,
	projectNotice,
} from "./events.ts";
import { responseDeliveryCheck } from "./guarded-response.ts";
import { CodexHost, jsonSchemaOf } from "./host.ts";
import {
	appendCodexJournal,
	commitCodexThread,
	initializeCodexSessionFile,
	inspectCodexSessionFile,
	loadCodexJournal,
	markCodexThreadPending,
	prepareCodexContext,
	readCodexSessionHeader,
} from "./identity.ts";
import { conversationTurn } from "./model.ts";
import { type CodexRpc, type CodexRpcOptions, createCodexRpc } from "./rpc.ts";
import { CodexSourceProvenance } from "./source-provenance.ts";

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
	readonly nativeEpoch: number;
	contextLineage(): readonly SessionContextExposure[];
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
	validateContextOptions(options);
	worldAuthorCapability(options);
	const identity = initializeCodexSessionFile(
		options.sessionFile,
		workspace,
		options.contextPolicy,
	);
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
	const author = worldAuthorCapability(options);
	const host = new CodexHost(
		workspace,
		options.permissions ??
			((name) => ({
				action: name === "bash" || name === "edit" ? "ask" : "allow",
			})),
	);
	const contextPolicy = new CodexContextPolicy(
		options,
		identity.sessionFile,
		workspace,
	);
	const listeners = new Set<(event: unknown) => void>();
	const history: ProjectedEntry[] = [...journalEntries(identity.sessionFile)];
	const nativeItems = new Map<string, number>();
	const ordinals = new Map<string, number>();
	const remember = (entry: ProjectedEntry) => {
		if (entry.codex && entry.message) {
			nativeItems.set(
				`${entry.codex.nativeEpoch ?? 0}:${entry.codex.turnId}:${entry.codex.nativeItemId}`,
				entry.codex.ordinal,
			);
			const key = `${entry.codex.nativeEpoch ?? 0}:${entry.codex.turnId}:${entry.message.role}`;
			ordinals.set(
				key,
				Math.max(ordinals.get(key) ?? 0, entry.codex.ordinal + 1),
			);
		}
	};
	for (const entry of history) remember(entry);
	const retain = (entry: ProjectedEntry) => {
		if (history.some((item) => item.id === entry.id)) return;
		const lineage = contextPolicy.entryLineage(entry.codex?.nativeEpoch ?? 0);
		const retained = lineage ? { ...entry, contextPolicy: lineage } : entry;
		appendCodexJournal(identity.sessionFile, retained);
		sourceProvenance.entry(retained);
		history.push(retained);
		remember(retained);
		return retained;
	};
	const waiters = new Set<Waiter>();
	const waitTimeoutMs = options.notificationTimeoutMs ?? 30_000;
	// Native turns may pause for user approval or run lengthy tools. EOF, explicit
	// interruption and close settle them; elapsed wall time alone is not failure.
	const runTimeoutMs = options.notificationTimeoutMs ?? null;
	let closed = false;
	let closing: Promise<void> | undefined;
	let ended = false;
	let boundThreadId: string | undefined;
	let boundModelProvider: string | undefined;
	let currentTurnId: string | undefined;
	let deliveredInstructions: string | undefined;
	let pendingStart = false;
	let promptAdmitted = false;
	let earlyCompletion: unknown;
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
	let startupCatalog: unknown;
	const assertContext = (): void => {
		author?.assert();
		contextPolicy.assertCurrent();
	};

	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event);
	};
	const sourceProvenance = new CodexSourceProvenance(
		identity.sessionFile,
		workspace,
		options.sourcePolicy,
		(entry) => emit({ type: "entry_appended", entry }),
	);
	contextPolicy.source = sourceProvenance;

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
		contextPolicy.note(turnId);
		pendingStart = false;
		turnReady?.resolve(turnId);
	};
	const reconcileEarlyCompletion = (): void => {
		if (currentTurnId && earlyCompletion) {
			const completion = earlyCompletion;
			earlyCompletion = undefined;
			receiveNotification("turn/completed", completion);
		}
	};

	const finalizeRun = (turnId?: string): void => {
		if (turnId) settledTurnIds.add(turnId);
		if (currentTurnId) settledTurnIds.add(currentTurnId);
		liveSeq = 0;
		currentTurnId = undefined;
		pendingStart = false;
		earlyCompletion = undefined;
		turnAbort?.abort();
		turnAbort = undefined;
		turnReady?.resolve(undefined);
	};

	const clearRun = (): void => {
		finalizeRun(currentTurnId);
	};

	const settleHost = (signal?: AbortSignal): void => {
		try {
			assertContext();
		} catch {
			return;
		}
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
		try {
			contextPolicy.attention();
		} catch (cause) {
			options.onError?.(
				asError(cause, "Failed to persist native attention").message,
			);
		}
		clearRun();
		failWaiters(error);
		if (!hadRun || closed) return;
		emit({ type: "continuation_error", errorMessage: error.message });
		emit({ type: "agent_settled" });
		settleHost();
	};

	const receiveNotification = (method: string, params: unknown): void => {
		try {
			const source = threadIdOf(params);
			const compacted =
				method === "thread/compacted" ||
				(method === "item/completed" &&
					isRecord(params) &&
					isRecord(params["item"]) &&
					params["item"]["type"] === "contextCompaction");
			if (contextPolicy.explicit && method !== "eof") {
				if (
					closed ||
					ended ||
					!boundThreadId ||
					source !== boundThreadId ||
					(liveSeq === 0 && !compacted)
				)
					return;
				try {
					assertContext();
				} catch {
					failRun(new Error("Context scope changed; attention required"));
					return;
				}
				const incomingTurn =
					isRecord(params) && typeof params["turnId"] === "string"
						? params["turnId"]
						: isRecord(params) && isRecord(params["turn"])
							? params["turn"]["id"]
							: undefined;
				if (incomingTurn && currentTurnId && incomingTurn !== currentTurnId)
					return;
			}
			if (boundThreadId && source && source !== boundThreadId) return;
			if (
				options.sourcePolicy &&
				method === "turn/completed" &&
				pendingStart &&
				!currentTurnId
			) {
				earlyCompletion = params;
				return;
			}
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
				contextPolicy.settle();
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
			let projection:
				| { turnId: string; ordinal: number; nativeEpoch?: number }
				| undefined;
			if (method === "item/completed" && isRecord(params)) {
				const item = projectCodexItem(params["item"]);
				const turnId =
					typeof params["turnId"] === "string"
						? params["turnId"]
						: options.sourcePolicy
							? undefined
							: currentTurnId;
				if (item?.message && turnId) {
					const key = `${contextPolicy.nativeEpoch}:${turnId}:${item.message.role}`;
					projection = {
						turnId,
						...(contextPolicy.nativeEpoch
							? { nativeEpoch: contextPolicy.nativeEpoch }
							: {}),
						ordinal:
							nativeItems.get(
								`${contextPolicy.nativeEpoch}:${turnId}:${item.id}`,
							) ??
							ordinals.get(key) ??
							0,
					};
				}
			}
			for (const event of eventsFromNotification(method, params, projection)) {
				if (
					isRecord(event) &&
					event["type"] === "entry_appended" &&
					isRecord(event["entry"])
				) {
					const retained = retain(event["entry"] as ProjectedEntry);
					if (!retained) continue;
					event["entry"] = retained;
				}
				emit(event);
			}
			if (method === "turn/started") reconcileEarlyCompletion();
		} catch (error) {
			failRun(asError(error, "Native provenance could not be persisted"));
		}
	};
	const unsubscribeRpc = rpc.subscribe(receiveNotification);

	const unsubscribeRequests = rpc.onRequest(
		async (method, params, beforeSend) => {
			const source = threadIdOf(params);
			if (contextPolicy.explicit && source !== boundThreadId)
				throw new Error("Foreign native context request");
			if (boundThreadId && source && source !== boundThreadId) return;
			const signal = turnAbort?.signal;
			const epoch = contextPolicy.nativeEpoch;
			const guard = (): void => {
				if (closed || ended || epoch !== contextPolicy.nativeEpoch)
					throw new Error("Native context is no longer active");
				signal?.throwIfAborted();
				try {
					assertContext();
				} catch {
					failRun(new Error("Context scope changed; attention required"));
					throw new Error("Context scope changed; delivery blocked");
				}
			};
			if (contextPolicy.explicit) beforeSend(guard);
			guard();
			if (author) {
				if (
					method === "item/commandExecution/requestApproval" ||
					method === "item/fileChange/requestApproval"
				)
					return { decision: "decline" };
				if (method === "item/permissions/requestApproval")
					return { permissions: {}, scope: "turn" };
				if (
					method !== "item/tool/call" ||
					!isRecord(params) ||
					typeof params["tool"] !== "string" ||
					!author.allowsTool(params["tool"])
				)
					throw Error("Native request is outside the bound author capability");
			}
			if (!signal) throw new Error("No active Codex turn for native request");
			const managedRequest = sourceProvenance.managed(contextPolicy.requestId);
			const sourceRequestId =
				isRecord(params) && typeof params["turnId"] === "string"
					? sourceProvenance.request(epoch, params["turnId"])
					: undefined;
			if (managedRequest && sourceRequestId !== contextPolicy.requestId)
				throw Error("Native request has no exact managed turn association");
			if (method === "item/tool/call" && isRecord(params)) {
				const tool = typeof params["tool"] === "string" ? params["tool"] : "";
				const callId =
					typeof params["callId"] === "string"
						? params["callId"]
						: randomUUID();
				const result = await host.invokeTool(
					tool,
					callId,
					params["arguments"],
					signal,
					contextPolicy.explicit ? guard : undefined,
				);
				guard();
				try {
					contextPolicy.plan({
						kind: "tool",
						requestId:
							sourceRequestId ?? contextPolicy.requestId ?? randomUUID(),
						toolName: tool,
						callId,
					});
				} catch (error) {
					if (options.sourcePolicy)
						failRun(asError(error, "Tool exposure could not be persisted"));
					throw error;
				}
				guard();
				return result;
			}
			if (
				method === "item/commandExecution/requestApproval" &&
				isRecord(params)
			) {
				const allow = await host.authorizeNative(
					"bash",
					typeof params["itemId"] === "string"
						? params["itemId"]
						: randomUUID(),
					{ command: params["command"], cwd: params["cwd"] },
					signal,
				);
				guard();
				return { decision: allow ? "accept" : "decline" };
			}
			if (method === "item/fileChange/requestApproval" && isRecord(params)) {
				const allow = await host.authorizeNative(
					"edit",
					typeof params["itemId"] === "string"
						? params["itemId"]
						: randomUUID(),
					{ reason: params["reason"] },
					signal,
				);
				guard();
				return { decision: allow ? "accept" : "decline" };
			}
		},
	);

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

	const injectInstructions = async (
		instructions: string,
		signal?: AbortSignal,
		beforeDeliver?: () => void,
	): Promise<void> => {
		author?.assert();
		if (instructions === deliveredInstructions) return;
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
			signal,
			beforeDeliver,
		);
		deliveredInstructions = instructions;
	};
	const bindNative = async (
		initial: ReturnType<typeof conversationTurn>,
	): Promise<void> => {
		author?.assert();
		let resumedForAudit:
			| { thread?: { id?: string; turns?: unknown; modelProvider?: string } }
			| undefined;
		let header = readCodexSessionHeader(identity.sessionFile, workspace);
		const policy = contextPolicy.current();
		let changed =
			policy &&
			(header.contextPolicy?.scopeDigest !== policy.scopeDigest ||
				header.contextTransition ||
				(options.sourcePolicy &&
					!sourceProvenance.proven(header.nativeEpoch ?? 0, { turns: [] })));
		if (
			policy &&
			header.nativeThreadId &&
			(!boundThreadId || changed || contextPolicy.uncertain)
		) {
			let prior = await rpc.request<{ thread?: unknown }>("thread/read", {
				threadId: header.nativeThreadId,
				includeTurns: true,
			});
			if (
				isRecord(prior.thread) &&
				isRecord(prior.thread["status"]) &&
				prior.thread["status"]["type"] === "notLoaded"
			) {
				// A newly owned process reports persisted threads as notLoaded. Only
				// settled history may be loaded, then the ordinary idle/run audit runs.
				if (
					contextPolicy.uncertain ||
					!Array.isArray(prior.thread["turns"]) ||
					prior.thread["turns"].some(
						(t) =>
							!isRecord(t) ||
							!["completed", "failed", "interrupted"].includes(
								String(t["status"]),
							),
					)
				)
					throw Error("Old native run is uncertain; attention required");
				await author?.preflight(rpc);
				author?.assert();
				resumedForAudit = await rpc.request("thread/resume", {
					threadId: header.nativeThreadId,
					...(author
						? {
								...author.threadParams,
								cwd: workspace,
								model: initial.model,
								modelProvider: initial.modelProvider,
								historyMode: "legacy",
							}
						: {}),
				});
				author?.verifyThread(resumedForAudit);
				prior = await rpc.request("thread/read", {
					threadId: header.nativeThreadId,
					includeTurns: true,
				});
			}
			contextPolicy.reconcile(prior.thread, header.nativeThreadId);
			for (const entry of historyFromTurns(
				isRecord(prior.thread) ? prior.thread["turns"] : undefined,
				header.nativeEpoch ?? 0,
			))
				retain(entry);
			if (
				options.sourcePolicy &&
				!sourceProvenance.proven(header.nativeEpoch ?? 0, prior.thread)
			)
				changed = true;
		}
		if (changed && policy) {
			header = prepareCodexContext(
				identity.sessionFile,
				workspace,
				policy,
				true,
			);
		}
		if (boundThreadId && !changed) {
			assertContext();
			return;
		}
		boundThreadId = undefined;
		settledTurnIds.clear();
		currentTurnId = undefined;
		tokens = null;
		const capturedBootstrap = options.bootstrapContext?.();
		const bootstrap =
			capturedBootstrap?.systemPrompt ??
			options.bootstrapInstructions?.() ??
			options.systemPrompt;
		if (typeof bootstrap !== "string")
			throw new Error("Invalid bootstrap instructions");
		const bootstrapGuard = () => {
			if (closed || ended) throw Error("Native bootstrap no longer active");
			if (policy?.scopeDigest !== contextPolicy.current()?.scopeDigest)
				throw Error("Bootstrap context scope changed");
			capturedBootstrap?.beforeDeliver?.();
		};
		const epoch =
			(header.nativeEpoch ?? 0) + (header.contextTransition ? 1 : 0);
		contextPolicy.adopt(policy, epoch);

		let threadId = header.nativeThreadId;
		if (author) {
			await author.preflight(rpc);
			author.assert();
		}
		if (threadId) {
			const resumed =
				resumedForAudit ??
				(await rpc.request<{
					thread?: { id?: string; turns?: unknown; modelProvider?: string };
				}>("thread/resume", {
					threadId,
					...(author
						? {
								...author.threadParams,
								cwd: workspace,
								model: initial.model,
								modelProvider: initial.modelProvider,
							}
						: {}),
				}));
			author?.verifyThread(resumed);
			if (resumed.thread?.id !== threadId)
				throw new Error("Codex resume did not return the bound native thread");
			boundModelProvider =
				typeof resumed.thread.modelProvider === "string"
					? resumed.thread.modelProvider
					: initial.modelProvider;
			for (const entry of historyFromTurns(resumed.thread?.turns, epoch))
				retain(entry);
		} else {
			const exposure = contextPolicy.plan(
				{
					kind: "bootstrap",
					requestId: header.contextTransition?.id ?? randomUUID(),
				},
				policy,
				epoch,
			);
			markCodexThreadPending(identity.sessionFile, workspace);
			const started = await rpc.request<{
				thread: { id: string; path?: string | null };
			}>(
				"thread/start",
				{
					cwd: workspace,
					model: initial.model,
					modelProvider: initial.modelProvider,
					...(author
						? author.threadParams
						: { approvalPolicy: "on-request", sandbox: "workspace-write" }),
					personality: "none",
					historyMode: "legacy",
					developerInstructions: bootstrap,
					dynamicTools: [...host.tools.values()].map((tool) => ({
						type: "function",
						name: tool.name,
						description: tool.description,
						inputSchema: jsonSchemaOf(tool.parameters),
					})),
				},
				undefined,
				bootstrapGuard,
			);
			author?.verifyThread(started);
			threadId = started.thread.id;
			deliveredInstructions = bootstrap;
			boundModelProvider = initial.modelProvider;
			commitCodexThread(
				identity.sessionFile,
				workspace,
				threadId,
				started.thread.path ?? undefined,
			);
			contextPolicy.delivered(exposure);
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
			epoch,
		))
			retain(entry);
		if (policy) contextPolicy.reconcile(read.thread, boundThreadId);
		currentTurnId = activeTurnId(read.thread);
		if (currentTurnId) turnAbort = new AbortController();
		if (
			!boundModelProvider &&
			isRecord(read.thread) &&
			typeof read.thread["modelProvider"] === "string"
		)
			boundModelProvider = read.thread["modelProvider"];
		if (policy) assertContext();
		if (
			header.nativeThreadId &&
			(options.bootstrapInstructions || options.bootstrapContext)
		) {
			const exposure = contextPolicy.plan({
				kind: "bootstrap",
				requestId: randomUUID(),
			});
			await injectInstructions(bootstrap, undefined, bootstrapGuard);
			assertContext();
			contextPolicy.delivered(exposure);
		}
	};

	try {
		await rpc.request("initialize", {
			clientInfo: { name: "lina", title: "Lina", version: "0.1.0" },
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		rpc.notify("initialized");
		const catalog = await rpc.request("model/list", {});
		startupCatalog = catalog;

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
		author?.bindTools([...host.tools.keys()]);

		await bindNative(
			author ? author.model(catalog) : conversationTurn(options, catalog),
		);
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
		get threadId() {
			return boundThreadId as string;
		},
		get nativeEpoch() {
			return contextPolicy.nativeEpoch;
		},
		contextLineage: () => contextPolicy.lineage(),
		...(options.sourcePolicy
			? {
					sourceEntryPolicy: (entryId: string) =>
						sourceProvenance.policy(entryId),
				}
			: {}),
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
			if (closed || ended)
				throw new Error("Codex session is closed or requires attention");
			if (promptAdmitted || currentTurnId || pendingStart)
				throw new Error("A native request is already active");
			promptAdmitted = true;
			try {
				author?.assert();
				const catalog = author
					? startupCatalog
					: await rpc.request("model/list", {});
				await bindNative(
					author ? author.model(catalog) : conversationTurn(options, catalog),
				);
				assertContext();
				const selected = author
					? author.model(catalog)
					: conversationTurn(options, catalog, boundModelProvider);
				const epoch = contextPolicy.nativeEpoch;
				const threadId = boundThreadId;
				const prepared = await host.beforeTurn(text, admission.signal);
				const checkPrepared = responseDeliveryCheck(prepared);
				const beforeDeliver = (): void => {
					if (
						closed ||
						ended ||
						epoch !== contextPolicy.nativeEpoch ||
						threadId !== boundThreadId
					)
						throw Error("Native context is no longer active");
					admission.signal.throwIfAborted();
					assertContext();
					checkPrepared?.();
				};
				assertContext();
				admission.signal.throwIfAborted();
				const additionalContext: Record<
					string,
					{ value: string; kind: string }
				> = {};
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
						const source = {
							kind: "turn" as const,
							requestId: admission.requestId ?? randomUUID(),
						};
						contextPolicy.begin(
							boundThreadId as string,
							source.requestId,
							admission.requestId !== undefined,
						);
						const instructions =
							prepared.systemPrompt ??
							options.bootstrapInstructions?.() ??
							options.systemPrompt;
						const exposure = contextPolicy.plan(source);
						await injectInstructions(
							instructions,
							admission.signal,
							beforeDeliver,
						);
						assertContext();

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
							undefined,
							beforeDeliver,
						);
						contextPolicy.delivered(exposure);
						assertContext();
						const startedId =
							typeof started.turn?.id === "string"
								? started.turn.id
								: undefined;
						if (startedId) {
							noteTurn(startedId);
							reconcileEarlyCompletion();
						} else {
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
						contextPolicy.attention();
						if (contextPolicy.uncertain) ended = true;
						pendingStart = false;
						turnReady.resolve(undefined);
						done.cancel(asError(error, "Codex turn/start failed"));
						clearRun();
						if (!admission.signal.aborted) admission.rejected();
						throw asError(error, "Codex turn/start failed");
					}
					if (abortRequested || admission.signal.aborted)
						await abortActiveTurn();
					await done.promise;
					admission.signal.throwIfAborted();
				} finally {
					admission.signal.removeEventListener("abort", onAbort);
					pendingStart = false;
				}
			} finally {
				promptAdmitted = false;
			}
		},
		async abort() {
			await abortActiveTurn();
		},
		clearQueue() {
			undefined;
		},
		async compact() {
			assertContext();
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
		close() {
			if (closing) return closing;
			closed = true;
			ended = true;
			// Publish one completion before hooks run, including a failed teardown.
			closing = Promise.resolve().then(async () => {
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
						assertContext();
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
			});
			return closing;
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
