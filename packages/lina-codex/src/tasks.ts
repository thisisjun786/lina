import { randomUUID } from "node:crypto";
import { jsonSchemaOf, validateToolArguments } from "./host.ts";
import {
	isTaskApprovalMethod,
	type TaskDynamicTool,
	type TaskManagerOptions,
	type TaskRpc,
	type TaskServerRequest,
	type TaskToolResult,
} from "./task-rpc.ts";
import { digestHex, TaskStore, toSummary } from "./task-store.ts";
import {
	type CreateTaskInput,
	type HandoverTaskInput,
	type MessageTaskInput,
	type ReplyApprovalInput,
	TASK_ID_PATTERN,
	TaskError,
	type TaskNotice,
	type TaskReadResult,
	type TaskSummary,
	type TaskThread,
} from "./task-types.ts";
import {
	activeTurnId,
	approvalDecisionResult,
	isArchivedError,
	notificationThreadId,
	notificationTurn,
	parseModel,
	parseThread,
	parseThreadId,
	parseTurnId,
	parseTurnsPage,
	threadStatusType,
	wrapNativeError,
} from "./tasks/native.ts";
import {
	CODEX_METHODS,
	createDigest,
	messageDigest,
	sha256Hex,
	threadIdFromParams,
	threadStartParams,
	turnStartParams,
	turnSteerParams,
} from "./tasks/protocol.ts";
import {
	expectedRevision,
	field,
	MODEL_MAX,
	ownerId,
	PROMPT_MAX,
	REQUEST_MAX,
	TITLE_MAX,
	taskId,
} from "./tasks/validate.ts";
import { validateWorkspace } from "./tasks/workspace.ts";

export type {
	TaskDynamicTool,
	TaskManagerOptions,
	TaskNotification,
	TaskRpc,
	TaskServerRequest,
	TaskToolResult,
} from "./task-rpc.ts";
export type {
	CreateTaskInput,
	HandoverTaskInput,
	MessageTaskInput,
	ReplyApprovalInput,
	TaskApproval,
	TaskErrorCode,
	TaskListResult,
	TaskNotice,
	TaskReadResult,
	TaskRecord,
	TaskSource,
	TaskSummary,
	TaskThread,
	TaskTurn,
} from "./task-types.ts";
export {
	isTaskError,
	TASK_ID_PATTERN,
	TASK_STATUSES,
	TaskError,
} from "./task-types.ts";

export type TaskNoticeMarker = {
	jobId: string;
	terminalRevision: number;
};
type Notifier = (
	marker: TaskNoticeMarker,
	text: string,
) => Promise<string | null>;

const LABELS: Record<string, string> = {
	idle: "완료",
	running: "작업 중",
	waiting_approval: "확인 대기",
	waiting_input: "입력 대기",
	interrupted: "중단됨",
	failed: "실패",
	needs_attention: "추가 확인 필요",
	creating: "시작 중",
};

const ARCHIVED_MESSAGE =
	"Native thread is archived or deleted; restore or unarchive it in Codex before Lina can continue. Lina will not fork a replacement thread.";

/**
 * Shared fleet Codex work-task manager.
 *
 * new TaskManager({ path, rpc, now?, id? })
 * rpc is the injected app-server JSON-RPC port. Main configures the shared
 * daemon proxy; this class never starts or restarts it.
 *
 * HTTP mapping owned by main:
 * GET /api/tasks -> { tasks: manager.list() }
 * GET /api/tasks/:id -> manager.read(id) = { task, thread }
 * POST create/message/interrupt/owner wrap { task: returned summary }
 * approval.reply may call manager.reply later
 */
export class TaskManager {
	private readonly store: TaskStore;
	private readonly rpc: TaskRpc;
	private readonly newId: () => string;
	private readonly dynamicTools: TaskDynamicTool[];
	private readonly executeTool: TaskManagerOptions["executeTool"];
	private readonly unsub: () => void;
	private readonly unsubRequests: (() => void) | undefined;
	private readonly listeners = new Set<(notice: TaskNotice) => void>();
	private readonly tails = new Map<string, Promise<void>>();
	private readonly attached = new Set<string>();
	private readonly controller = new AbortController();
	private closed = false;
	private closing: Promise<void> | undefined;
	private notifier: Notifier | undefined;
	private notifying: Promise<void> | undefined;
	private readonly pendingApprovals = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: unknown) => void;
			taskId: string;
		}
	>();

	constructor(options: TaskManagerOptions) {
		this.store = new TaskStore(options.path, options.now);
		this.rpc = options.rpc;
		this.newId = options.id ?? randomUUID;
		this.dynamicTools = options.dynamicTools ?? [];
		this.executeTool = options.executeTool;
		this.store.recover();
		this.pendingApprovals.clear();
		this.unsub = this.rpc.subscribe((notification) => {
			if (notification.method === "eof") this.attached.clear();
			void this.safeEnqueue(
				notificationThreadId(notification.method, notification.params),
				() => this.onNotification(notification),
			);
		});
		this.unsubRequests = this.rpc.subscribeRequests?.((request) => {
			void this.onIncomingRequest(request).catch(() => undefined);
		});
	}

	/** Reattach saved tasks in order, without blocking fleet settings startup. */
	async restore(): Promise<void> {
		for (const task of this.list()) {
			if (this.closed) return;
			if (!task.threadId) continue;
			try {
				await this.read(task.id);
			} catch {
				/* read exposes disconnected/archive errors when opened */
			}
		}
	}

	list(): TaskSummary[] {
		this.ensureOpen();
		return this.store.list();
	}

	create(input: CreateTaskInput): Promise<TaskSummary> {
		this.ensureOpen();
		const ownerAgentId = ownerId(input.ownerAgentId);
		const title = field(input.title, "title", TITLE_MAX);
		const prompt = field(input.prompt, "prompt", PROMPT_MAX);
		const requestId = field(input.requestId, "requestId", REQUEST_MAX);
		const cwd = validateWorkspace(input.cwd);
		const model =
			input.model === undefined ? null : field(input.model, "model", MODEL_MAX);
		const digest = createDigest({ ownerAgentId, title, cwd, prompt, model });
		return this.enqueue(`origin:${requestId}`, async () => {
			const existing = this.store.byRequestId(requestId);
			if (existing) {
				if (existing.inputDigest !== sha256Hex(digest))
					throw new TaskError(
						"conflict",
						"requestId is bound to conflicting create arguments",
					);
				return toSummary(existing);
			}
			const id = this.newId();
			if (!TASK_ID_PATTERN.test(id))
				throw new TaskError("invalid_input", "invalid task id");
			this.store.createPending({
				id,
				requestId,
				ownerAgentId,
				title,
				cwd,
				prompt,
				model,
				digest,
			});
			this.emitChange(id);
			return await this.enqueue(`task:${id}`, () =>
				this.startNative(id, cwd, prompt, requestId, model, title),
			);
		});
	}

	read(id: string): Promise<TaskReadResult> {
		this.ensureOpen();
		const idValue = taskId(id);
		return this.enqueue(`task:${idValue}`, async () => {
			this.store.require(idValue);
			const thread = await this.reconcile(idValue);
			return { task: this.store.record(idValue), thread };
		});
	}

	message(id: string, input: MessageTaskInput): Promise<TaskSummary> {
		this.ensureOpen();
		const idValue = taskId(id);
		const text = field(input.text, "text", PROMPT_MAX);
		const requestId = field(input.requestId, "requestId", REQUEST_MAX);
		const expected = expectedRevision(input.expectedRevision);
		return this.enqueue(`task:${idValue}`, async () => {
			const digest = messageDigest({ taskId: idValue, text });
			const prior = this.store.findRequest(requestId);
			if (prior) {
				if (prior.taskId !== idValue || prior.digest !== digestHex(digest))
					throw new TaskError(
						"conflict",
						"requestId is bound to conflicting arguments",
					);
				return this.store.summary(idValue);
			}
			await this.requireRevision(idValue, expected);
			const thread = await this.reconcile(idValue);
			const latest = await this.requireRevision(idValue, expected);
			if (!latest.threadId)
				throw new TaskError(
					"native_unavailable",
					"task has no native thread id; Lina will not fork a replacement",
				);
			this.store.recordRequest(requestId, idValue, "message", digest);
			this.store.setPending(idValue, "turn", requestId);
			try {
				const active = thread ? activeTurnId(thread) : latest.lastTurnId;
				if (active) {
					await this.rpc.request(
						CODEX_METHODS.turnSteer,
						turnSteerParams({
							threadId: latest.threadId,
							text,
							requestId,
							expectedTurnId: active,
						}),
						this.controller.signal,
					);
					this.store.completeTurn(idValue, {
						turnId: active,
						status: "running",
						messageId: requestId,
					});
				} else {
					const started = await this.rpc.request(
						CODEX_METHODS.turnStart,
						turnStartParams({
							threadId: latest.threadId,
							text,
							requestId,
							...(latest.model === null ? {} : { model: latest.model }),
						}),
						this.controller.signal,
					);
					this.store.completeTurn(idValue, {
						turnId: parseTurnId(started),
						status: "running",
						messageId: requestId,
					});
				}
				this.emitChange(idValue);
				return this.store.summary(idValue);
			} catch (error) {
				return this.failNative(idValue, error);
			}
		});
	}

	interrupt(id: string, expected: number): Promise<TaskSummary> {
		this.ensureOpen();
		const idValue = taskId(id);
		const revision = expectedRevision(expected);
		return this.enqueue(`task:${idValue}`, async () => {
			await this.requireRevision(idValue, revision);
			const thread = await this.reconcile(idValue);
			const latest = await this.requireRevision(idValue, revision);
			const turnId = thread ? activeTurnId(thread) : latest.lastTurnId;
			if (!latest.threadId || !turnId)
				throw new TaskError(
					"native_unavailable",
					"no active turn to interrupt",
				);
			this.store.setPending(idValue, "interrupt", null);
			try {
				await this.rpc.request(
					CODEX_METHODS.turnInterrupt,
					{ threadId: latest.threadId, turnId },
					this.controller.signal,
				);
				this.store.completeTurn(idValue, { turnId, status: "interrupted" });
				this.completeNotice(idValue, `${turnId}:interrupted`);
				this.emitChange(idValue);
				return this.store.summary(idValue);
			} catch (error) {
				return this.failNative(idValue, error);
			}
		});
	}

	handover(id: string, input: HandoverTaskInput): Promise<TaskSummary> {
		this.ensureOpen();
		const idValue = taskId(id);
		const nextOwner = ownerId(input.ownerAgentId);
		const revision = expectedRevision(input.expectedRevision);
		return this.enqueue(`task:${idValue}`, async () => {
			const current = await this.requireRevision(idValue, revision);
			if (current.ownerAgentId !== nextOwner)
				this.store.handover(idValue, nextOwner);
			this.emitChange(idValue);
			return this.store.summary(idValue);
		});
	}

	reply(id: string, input: ReplyApprovalInput): Promise<TaskSummary> {
		this.ensureOpen();
		const idValue = taskId(id);
		const approvalId = field(input.approvalId, "approvalId", 256);
		const revision = expectedRevision(input.expectedRevision);
		return this.enqueue(`task:${idValue}`, async () => {
			await this.requireRevision(idValue, revision);
			const approval = this.store
				.approvals(idValue)
				.find((item) => item.id === approvalId);
			if (!approval)
				throw new TaskError(
					"approval_unavailable",
					"no pending approval to answer; refusing to auto-approve",
				);
			if (!this.rpc.respond || !this.pendingApprovals.has(approval.id))
				throw new TaskError(
					"approval_unavailable",
					"approval was invalidated by reconnect or is unavailable; refusing to auto-approve",
				);
			try {
				await this.rpc.respond(
					approval.id,
					approvalDecisionResult(approval.method, input.decision),
				);
			} catch {
				this.pendingApprovals.delete(approval.id);
				this.store.removeApproval(idValue, approval.id);
				throw new TaskError(
					"approval_unavailable",
					"approval was invalidated by reconnect; wait for a new approval prompt",
				);
			}
			this.pendingApprovals.delete(approval.id);
			this.store.removeApproval(idValue, approval.id);
			await this.reconcile(idValue);
			this.emitChange(idValue);
			return this.store.summary(idValue);
		});
	}

	subscribe(listener: (notice: TaskNotice) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	setNotifier(notifier: Notifier): void {
		this.notifier = notifier;
		void this.flushNotices();
	}

	flushNotices(): Promise<void> {
		if (this.notifying) return this.notifying;
		if (this.closed || !this.notifier) return Promise.resolve();
		this.notifying = (async () => {
			for (;;) {
				const pending = this.store.pendingNotices();
				if (!pending.length || this.closed || !this.notifier) return;
				for (const task of pending) {
					if (this.closed || !this.notifier) return;
					const entryId = await this.notifier(
						{ jobId: task.id, terminalRevision: Math.max(1, task.revision) },
						`${task.title.slice(0, 240)}\n\n${LABELS[task.status] ?? task.status}`,
					);
					if (entryId === null) return;
					if (task.noticeKey)
						this.store.markNoticeDelivered(task.id, task.noticeKey);
				}
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				this.notifying = undefined;
			});
		return this.notifying;
	}

	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.controller.abort();
		this.unsub();
		this.unsubRequests?.();
		for (const pending of this.pendingApprovals.values())
			pending.reject(new TaskError("closed", "task manager is closed"));
		this.pendingApprovals.clear();
		this.closing = (async () => {
			await Promise.allSettled([...this.tails.values()]);
			await this.notifying;
			this.listeners.clear();
			this.store.close();
		})();
		return this.closing;
	}

	private async startNative(
		id: string,
		cwd: string,
		prompt: string,
		requestId: string,
		model: string | null,
		title: string,
	): Promise<TaskSummary> {
		try {
			const started = await this.rpc.request(
				CODEX_METHODS.threadStart,
				threadStartParams({
					cwd,
					...(model === null ? {} : { model }),
					...(this.dynamicTools.length > 0
						? { dynamicTools: this.dynamicTools }
						: {}),
				}),
				this.controller.signal,
			);
			const threadId = parseThreadId(started);
			this.store.attachThread(id, threadId, parseModel(started) ?? model);
			this.attached.add(threadId);
			try {
				await this.rpc.request(
					CODEX_METHODS.threadNameSet,
					{ threadId, name: title },
					this.controller.signal,
				);
			} catch {
				// Lina title remains authoritative if native rename is unavailable.
			}
			const turn = await this.rpc.request(
				CODEX_METHODS.turnStart,
				turnStartParams({
					threadId,
					text: prompt,
					requestId,
					...(model === null ? {} : { model }),
				}),
				this.controller.signal,
			);
			this.store.completeTurn(id, {
				turnId: parseTurnId(turn),
				status: "running",
				messageId: requestId,
			});
			this.emitChange(id);
			return this.store.summary(id);
		} catch (error) {
			return this.failNative(id, error);
		}
	}

	private failNative(id: string, error: unknown): never {
		this.store.fail(id, error instanceof Error ? error.message : String(error));
		this.emitChange(id);
		void this.flushNotices();
		throw wrapNativeError(error);
	}

	private async requireRevision(id: string, expected: number) {
		const current = this.store.require(id);
		if (current.revision !== expected)
			throw new TaskError("revision_mismatch", "task revision does not match");
		return current;
	}

	private ensureOpen(): void {
		if (this.closed) throw new TaskError("closed", "task manager is closed");
	}

	private enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		const run = prev.then(fn, fn);
		this.tails.set(
			key,
			run.then(
				() => undefined,
				() => undefined,
			),
		);
		return run;
	}

	private safeEnqueue(
		threadId: string | null,
		fn: () => Promise<void>,
	): Promise<void> {
		if (!threadId) return Promise.resolve();
		const task = this.store.byThreadId(threadId);
		if (!task) return Promise.resolve();
		return this.enqueue(`task:${task.id}`, fn).catch(() => undefined);
	}

	private async reconcile(id: string): Promise<TaskThread | null> {
		const task = this.store.require(id);
		if (!task.threadId) return null;
		try {
			if (!this.attached.has(task.threadId)) {
				const resumed = await this.rpc.request(
					CODEX_METHODS.threadResume,
					{ threadId: task.threadId },
					this.controller.signal,
				);
				if (parseThreadId(resumed) !== task.threadId)
					throw Error("Codex task resume returned a different thread");
				this.attached.add(task.threadId);
			}
			let raw: unknown = await this.rpc.request(
				CODEX_METHODS.threadRead,
				{ threadId: task.threadId, includeTurns: true },
				this.controller.signal,
			);
			let thread = parseThread(raw);
			if (threadStatusType(thread.status) === "notLoaded") {
				await this.rpc.request(
					CODEX_METHODS.threadResume,
					{ threadId: task.threadId },
					this.controller.signal,
				);
				raw = await this.rpc.request(
					CODEX_METHODS.threadRead,
					{ threadId: task.threadId, includeTurns: true },
					this.controller.signal,
				);
				thread = parseThread(raw);
			}
			if (thread.turns.length === 0) {
				try {
					const page = await this.rpc.request(
						CODEX_METHODS.threadTurnsList,
						{ threadId: task.threadId, itemsView: "full" },
						this.controller.signal,
					);
					thread = { ...thread, turns: parseTurnsPage(page) };
				} catch {
					// Status-only reconciliation still applies.
				}
			}
			const before = this.store.require(id);
			this.store.applyNative(id, thread);
			if (before.revision !== this.store.require(id).revision)
				this.emitChange(id);
			return thread;
		} catch (error) {
			if (isArchivedError(error)) {
				this.store.fail(id, ARCHIVED_MESSAGE);
				this.emitChange(id);
				void this.flushNotices();
				throw new TaskError("native_archived", ARCHIVED_MESSAGE);
			}
			throw wrapNativeError(error);
		}
	}

	private async onNotification(notification: {
		method: string;
		params: unknown;
	}): Promise<void> {
		const threadId = notificationThreadId(
			notification.method,
			notification.params,
		);
		if (!threadId) return;
		const task = this.store.byThreadId(threadId);
		if (!task) return;
		if (notification.method === "turn/completed") {
			const turn = notificationTurn(notification.params);
			const status =
				turn?.status === "interrupted"
					? "interrupted"
					: turn?.status === "failed"
						? "failed"
						: "idle";
			this.store.completeTurn(task.id, {
				turnId: turn?.id ?? task.lastTurnId,
				status,
			});
			if (turn) this.completeNotice(task.id, `${turn.id}:${turn.status}`);
			this.emitChange(task.id);
			return;
		}
		if (notification.method === "thread/status/changed")
			await this.reconcile(task.id);
	}

	private async onIncomingRequest(request: TaskServerRequest): Promise<void> {
		if (request.method === "item/tool/call") {
			const threadId = threadIdFromParams(request.params);
			const task = threadId ? this.store.byThreadId(threadId) : undefined;
			if (!task) return;
			await this.enqueue(`task:${task.id}`, () => this.handleToolCall(request));
			return;
		}
		if (!isTaskApprovalMethod(request.method)) return;
		const threadId = threadIdFromParams(request.params);
		if (!threadId) return;
		const task = this.store.byThreadId(threadId);
		if (!task) return;
		await this.enqueue(`task:${task.id}`, async () => {
			this.store.addApproval({
				id: String(request.id),
				taskId: task.id,
				method: request.method,
				params: request.params,
			});
			this.pendingApprovals.set(String(request.id), {
				resolve: () => undefined,
				reject: () => undefined,
				taskId: task.id,
			});
			this.store.completeTurn(task.id, {
				turnId: task.lastTurnId,
				status: "waiting_approval",
			});
			this.emitChange(task.id);
		});
	}

	private async handleToolCall(request: TaskServerRequest): Promise<void> {
		const threadId = threadIdFromParams(request.params);
		if (!threadId) return;
		const task = this.store.byThreadId(threadId);
		if (!task) return;
		const body =
			request.params &&
			typeof request.params === "object" &&
			!Array.isArray(request.params)
				? (request.params as Record<string, unknown>)
				: {};
		const tool = typeof body["tool"] === "string" ? body["tool"] : "";
		const callId =
			typeof body["callId"] === "string" ? body["callId"] : String(request.id);
		const specification = this.dynamicTools.find((item) => item.name === tool);
		let result: TaskToolResult = {
			contentItems: [{ type: "inputText", text: "tool is unavailable" }],
			success: false,
		};
		if (specification && this.executeTool) {
			try {
				result = await this.executeTool(
					tool,
					callId,
					validateToolArguments(
						jsonSchemaOf(specification.inputSchema),
						body["arguments"],
					),
					this.controller.signal,
				);
			} catch (error) {
				result = {
					contentItems: [
						{
							type: "inputText",
							text: error instanceof Error ? error.message : String(error),
						},
					],
					success: false,
				};
			}
		}
		if (!this.rpc.respond) return;
		await this.rpc.respond(request.id, result);
	}

	private completeNotice(id: string, noticeKey: string): void {
		const marked = this.store.markCompletion(id, noticeKey);
		if (!marked) return;
		const task = toSummary(marked);
		for (const listener of this.listeners)
			listener({ type: "completion", task, noticeKey });
		void this.flushNotices();
	}

	private emitChange(id: string): void {
		const stored = this.store.get(id);
		if (!stored) return;
		const task = toSummary(stored);
		for (const listener of this.listeners)
			listener({ type: "change", task, source: stored.source });
	}
}
