import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openCheckedDatabase } from "../../lina-core/src/session-binding.ts";
import { initializeTaskSchema } from "./task-schema.ts";
import type { TaskThread } from "./task-types.ts";
import {
	TASK_ID_PATTERN,
	type TaskApproval,
	TaskError,
	type TaskRecord,
	type TaskSource,
	type TaskSummary,
} from "./task-types.ts";
import {
	activeTurnId,
	hasExternalUserInput,
	mapThreadStatus,
} from "./tasks/native.ts";

export type PendingKind = "create" | "turn" | "interrupt";
export type NoticeState = "none" | "pending" | "delivered";

export type StoredTask = {
	id: string;
	requestId: string;
	ownerAgentId: string;
	title: string;
	cwd: string;
	prompt: string;
	model: string | null;
	threadId: string | null;
	status: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	lastTurnId: string | null;
	lastError: string | null;
	source: TaskSource;
	inputDigest: string;
	pendingKind: PendingKind | null;
	pendingRequestId: string | null;
	noticeState: NoticeState;
	noticeKey: string | null;
	knownTurnIds: string[];
	knownMessageIds: string[];
};

export type StoredRequest = {
	requestId: string;
	taskId: string;
	kind: string;
	digest: string;
};

type Row = Record<string, unknown>;

const nowIso = () => new Date().toISOString();

function strings(value: unknown): string[] {
	if (typeof value !== "string") throw new Error("invalid task id list");
	const parsed: unknown = JSON.parse(value);
	if (
		!Array.isArray(parsed) ||
		parsed.length > 4096 ||
		parsed.some((item) => typeof item !== "string" || item.length > 256)
	)
		throw new Error("invalid task id list");
	return parsed;
}

export function digestHex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function fromRow(row: unknown): StoredTask {
	if (!row || typeof row !== "object") throw new Error("invalid task row");
	const r = row as Row;
	const source = r["source"];
	const pending = r["pending_kind"];
	const notice = r["notice_state"];
	if (
		typeof r["id"] !== "string" ||
		!TASK_ID_PATTERN.test(r["id"]) ||
		typeof r["request_id"] !== "string" ||
		typeof r["owner_agent_id"] !== "string" ||
		typeof r["title"] !== "string" ||
		typeof r["cwd"] !== "string" ||
		typeof r["prompt"] !== "string" ||
		(r["model"] !== null && typeof r["model"] !== "string") ||
		(r["thread_id"] !== null && typeof r["thread_id"] !== "string") ||
		typeof r["status"] !== "string" ||
		typeof r["revision"] !== "number" ||
		!Number.isSafeInteger(r["revision"]) ||
		r["revision"] < 0 ||
		typeof r["created_at"] !== "string" ||
		typeof r["updated_at"] !== "string" ||
		(r["last_turn_id"] !== null && typeof r["last_turn_id"] !== "string") ||
		(r["last_error"] !== null && typeof r["last_error"] !== "string") ||
		(source !== "lina" && source !== "external") ||
		typeof r["input_digest"] !== "string" ||
		(pending !== null &&
			pending !== "create" &&
			pending !== "turn" &&
			pending !== "interrupt") ||
		(r["pending_request_id"] !== null &&
			typeof r["pending_request_id"] !== "string") ||
		(notice !== "none" && notice !== "pending" && notice !== "delivered") ||
		(r["notice_key"] !== null && typeof r["notice_key"] !== "string")
	)
		throw new Error("invalid task row");
	return {
		id: r["id"],
		requestId: r["request_id"],
		ownerAgentId: r["owner_agent_id"],
		title: r["title"],
		cwd: r["cwd"],
		prompt: r["prompt"],
		model: r["model"],
		threadId: r["thread_id"],
		status: r["status"],
		revision: r["revision"],
		createdAt: r["created_at"],
		updatedAt: r["updated_at"],
		lastTurnId: r["last_turn_id"],
		lastError: r["last_error"],
		source,
		inputDigest: r["input_digest"],
		pendingKind: pending,
		pendingRequestId: r["pending_request_id"],
		noticeState: notice,
		noticeKey: r["notice_key"],
		knownTurnIds: strings(r["known_turn_ids_json"]),
		knownMessageIds: strings(r["known_message_ids_json"]),
	};
}

export function toSummary(task: StoredTask): TaskSummary {
	return {
		id: task.id,
		threadId: task.threadId,
		ownerAgentId: task.ownerAgentId,
		title: task.title,
		cwd: task.cwd,
		status: task.status,
		revision: task.revision,
		updatedAt: task.updatedAt,
		model: task.model,
	};
}

export class TaskStore {
	private readonly db: DatabaseSync;
	private closed = false;
	constructor(
		path: string,
		private readonly clock: () => string = nowIso,
	) {
		const opened = openCheckedDatabase(path);
		this.db = opened.db;
		try {
			this.db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
			initializeTaskSchema(this.db, opened.fresh);
			for (const row of this.db.prepare("SELECT * FROM tasks").all())
				fromRow(row);
			this.db.exec("COMMIT");
			this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
		} catch (error) {
			if (this.db.isTransaction) this.db.exec("ROLLBACK");
			this.db.close();
			throw error;
		}
	}

	clearApprovals(): void {
		this.tx(() => this.db.exec("DELETE FROM task_approvals"));
	}

	recover(): StoredTask[] {
		this.clearApprovals();
		const recovered: StoredTask[] = [];
		for (const task of this.all()) {
			if (task.status === "waiting_approval") {
				recovered.push(
					this.patch(task.id, {
						status: "needs_attention",
						pendingKind: null,
						pendingRequestId: null,
						lastError:
							"Pending Codex approval was invalidated by reconnect; wait for a new approval prompt. Lina will not auto-approve.",
					}),
				);
				continue;
			}
			if (!task.pendingKind) continue;
			const failed = !task.threadId;
			recovered.push(
				this.patch(task.id, {
					status: failed ? "failed" : "needs_attention",
					pendingKind: null,
					pendingRequestId: null,
					lastError: failed
						? "In-flight create was interrupted by process restart; Lina did not resend thread/start."
						: `In-flight ${task.pendingKind} was interrupted by process restart; Lina did not resend it.`,
					noticeState: "pending",
					noticeKey: `recover:${task.pendingKind}`,
					source: task.source,
				}),
			);
		}
		return recovered;
	}

	createPending(input: {
		id: string;
		requestId: string;
		ownerAgentId: string;
		title: string;
		cwd: string;
		prompt: string;
		model: string | null;
		digest: string;
	}): StoredTask {
		const existing = this.byRequestId(input.requestId);
		if (existing) {
			if (existing.inputDigest !== digestHex(input.digest))
				throw new TaskError(
					"conflict",
					"requestId is bound to conflicting create arguments",
				);
			return existing;
		}
		const t = this.clock();
		this.tx(() => {
			this.db
				.prepare(
					"INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
				)
				.run(
					input.id,
					input.requestId,
					input.ownerAgentId,
					input.title,
					input.cwd,
					input.prompt,
					input.model,
					null,
					"creating",
					0,
					t,
					t,
					null,
					null,
					"lina",
					digestHex(input.digest),
					"create",
					input.requestId,
					"none",
					null,
					"[]",
					JSON.stringify([input.requestId]),
				);
			this.db
				.prepare(
					"INSERT INTO task_requests(request_id,task_id,kind,digest) VALUES (?,?,?,?)",
				)
				.run(input.requestId, input.id, "create", digestHex(input.digest));
		});
		return this.require(input.id);
	}

	attachThread(id: string, threadId: string, model: string | null): StoredTask {
		const task = this.require(id);
		return this.patch(id, {
			threadId,
			model: model ?? task.model,
			pendingKind: "turn",
			pendingRequestId: task.requestId,
			knownTurnIds: task.knownTurnIds,
			knownMessageIds: task.knownMessageIds,
		});
	}

	completeTurn(
		id: string,
		input: {
			turnId: string | null;
			status: string;
			messageId?: string;
			pendingKind?: PendingKind | null;
		},
	): StoredTask {
		const task = this.require(id);
		const knownTurnIds =
			input.turnId && !task.knownTurnIds.includes(input.turnId)
				? [...task.knownTurnIds, input.turnId]
				: task.knownTurnIds;
		const knownMessageIds =
			input.messageId && !task.knownMessageIds.includes(input.messageId)
				? [...task.knownMessageIds, input.messageId]
				: task.knownMessageIds;
		return this.patch(id, {
			status: input.status,
			lastTurnId: input.turnId ?? task.lastTurnId,
			pendingKind: input.pendingKind === undefined ? null : input.pendingKind,
			pendingRequestId: input.pendingKind ? task.pendingRequestId : null,
			lastError: null,
			knownTurnIds,
			knownMessageIds,
			source: task.source,
		});
	}

	setPending(
		id: string,
		kind: PendingKind,
		requestId: string | null,
	): StoredTask {
		return this.patch(id, {
			pendingKind: kind,
			pendingRequestId: requestId,
		});
	}

	clearPending(id: string): StoredTask {
		return this.patch(id, { pendingKind: null, pendingRequestId: null });
	}

	fail(id: string, reason: string): StoredTask {
		const task = this.require(id);
		return this.patch(id, {
			status: task.threadId ? "needs_attention" : "failed",
			pendingKind: null,
			pendingRequestId: null,
			lastError: reason.slice(0, 1024),
			noticeState: "pending",
			noticeKey: `fail:${task.pendingKind ?? "rpc"}`,
		});
	}

	handover(id: string, ownerAgentId: string): StoredTask {
		return this.patch(id, { ownerAgentId });
	}

	applyNative(id: string, thread: TaskThread): StoredTask {
		const task = this.require(id);
		const known = new Set(task.knownMessageIds);
		const external = hasExternalUserInput(thread, known);
		const mapped = mapThreadStatus(thread.status);
		const status =
			(task.status === "interrupted" || task.status === "failed") &&
			mapped === "idle"
				? task.status
				: mapped;
		const turnId = activeTurnId(thread) ?? task.lastTurnId;
		const model = thread.model ?? task.model;
		const source: TaskSource = external ? "external" : task.source;
		const knownTurnIds = [...task.knownTurnIds];
		for (const turn of thread.turns) {
			if (!knownTurnIds.includes(turn.id)) knownTurnIds.push(turn.id);
		}
		if (
			task.status === status &&
			task.source === source &&
			task.lastTurnId === turnId &&
			task.model === model
		)
			return task;
		return this.patch(id, {
			status,
			source,
			lastTurnId: turnId,
			model,
			knownTurnIds,
			lastError: status === "failed" ? task.lastError : null,
		});
	}

	markCompletion(id: string, noticeKey: string): StoredTask | null {
		const task = this.require(id);
		if (task.noticeKey === noticeKey) return null;
		return this.patch(id, { noticeState: "pending", noticeKey });
	}

	markNoticeDelivered(id: string, noticeKey: string): void {
		this.tx(() => {
			this.db
				.prepare(
					"UPDATE tasks SET notice_state='delivered' WHERE id=? AND notice_key=? AND notice_state='pending'",
				)
				.run(id, noticeKey);
		});
	}

	pendingNotices(): StoredTask[] {
		return this.db
			.prepare(
				"SELECT * FROM tasks WHERE notice_state='pending' ORDER BY updated_at,id",
			)
			.all()
			.map(fromRow);
	}

	recordRequest(
		requestId: string,
		taskId: string,
		kind: string,
		digest: string,
	): StoredRequest {
		const existing = this.findRequest(requestId);
		if (existing) {
			if (existing.taskId !== taskId || existing.digest !== digestHex(digest))
				throw new TaskError(
					"conflict",
					"requestId is bound to conflicting arguments",
				);
			return existing;
		}
		this.tx(() => {
			this.db
				.prepare(
					"INSERT INTO task_requests(request_id,task_id,kind,digest) VALUES (?,?,?,?)",
				)
				.run(requestId, taskId, kind, digestHex(digest));
		});
		return { requestId, taskId, kind, digest: digestHex(digest) };
	}

	findRequest(requestId: string): StoredRequest | undefined {
		const row = this.db
			.prepare("SELECT * FROM task_requests WHERE request_id=?")
			.get(requestId) as Row | undefined;
		if (!row) return;
		if (
			typeof row["request_id"] !== "string" ||
			typeof row["task_id"] !== "string" ||
			typeof row["kind"] !== "string" ||
			typeof row["digest"] !== "string"
		)
			throw new Error("invalid task request row");
		return {
			requestId: row["request_id"],
			taskId: row["task_id"],
			kind: row["kind"],
			digest: row["digest"],
		};
	}

	addApproval(input: {
		id: string;
		taskId: string;
		method: string;
		params: unknown;
	}): TaskApproval {
		const createdAt = this.clock();
		this.tx(() => {
			this.db
				.prepare(
					"INSERT OR IGNORE INTO task_approvals(id,task_id,method,params_json,created_at) VALUES (?,?,?,?,?)",
				)
				.run(
					input.id,
					input.taskId,
					input.method,
					JSON.stringify(input.params ?? null),
					createdAt,
				);
		});
		const stored = this.approvals(input.taskId).find(
			(item) => item.id === input.id,
		);
		if (!stored) throw new Error("approval persist failed");
		return stored;
	}

	removeApproval(taskId: string, approvalId: string): void {
		this.tx(() => {
			this.db
				.prepare("DELETE FROM task_approvals WHERE task_id=? AND id=?")
				.run(taskId, approvalId);
		});
	}

	approvals(taskId: string): TaskApproval[] {
		return this.db
			.prepare(
				"SELECT id,method,params_json,created_at FROM task_approvals WHERE task_id=? ORDER BY created_at,id",
			)
			.all(taskId)
			.map((row) => {
				const r = row as Row;
				if (
					typeof r["id"] !== "string" ||
					typeof r["method"] !== "string" ||
					typeof r["params_json"] !== "string" ||
					typeof r["created_at"] !== "string"
				)
					throw new Error("invalid approval row");
				return {
					id: r["id"],
					method: r["method"],
					params: JSON.parse(r["params_json"]) as unknown,
					createdAt: r["created_at"],
				};
			});
	}

	byRequestId(requestId: string): StoredTask | undefined {
		const row = this.db
			.prepare("SELECT * FROM tasks WHERE request_id=?")
			.get(requestId);
		return row ? fromRow(row) : undefined;
	}

	byThreadId(threadId: string): StoredTask | undefined {
		const row = this.db
			.prepare(
				"SELECT * FROM tasks WHERE thread_id=? ORDER BY created_at LIMIT 1",
			)
			.get(threadId);
		return row ? fromRow(row) : undefined;
	}

	get(id: string): StoredTask | undefined {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
		return row ? fromRow(row) : undefined;
	}

	require(id: string): StoredTask {
		const task = this.get(id);
		if (!task) throw new TaskError("unknown_task", "unknown task");
		return task;
	}

	record(id: string): TaskRecord {
		const task = this.require(id);
		return {
			...toSummary(task),
			createdAt: task.createdAt,
			prompt: task.prompt,
			requestId: task.requestId,
			lastTurnId: task.lastTurnId,
			lastError: task.lastError,
			source: task.source,
			pendingApprovals: this.approvals(id),
		};
	}

	list(): TaskSummary[] {
		return this.db
			.prepare("SELECT * FROM tasks ORDER BY updated_at DESC, id DESC")
			.all()
			.map((row) => toSummary(fromRow(row)));
	}

	summary(id: string): TaskSummary {
		return toSummary(this.require(id));
	}

	close(): void {
		if (this.closed) return;
		this.db.close();
		this.closed = true;
	}

	private all(): StoredTask[] {
		return this.db
			.prepare("SELECT * FROM tasks ORDER BY created_at")
			.all()
			.map(fromRow);
	}

	private patch(
		id: string,
		patch: Partial<
			Pick<
				StoredTask,
				| "ownerAgentId"
				| "threadId"
				| "status"
				| "model"
				| "lastTurnId"
				| "lastError"
				| "source"
				| "pendingKind"
				| "pendingRequestId"
				| "noticeState"
				| "noticeKey"
				| "knownTurnIds"
				| "knownMessageIds"
			>
		>,
	): StoredTask {
		const task = this.require(id);
		const next: StoredTask = {
			...task,
			...patch,
			revision: task.revision + 1,
			updatedAt: this.clock(),
		};
		this.tx(() => {
			this.db
				.prepare(
					"UPDATE tasks SET owner_agent_id=?,thread_id=?,status=?,revision=?,updated_at=?,last_turn_id=?,last_error=?,source=?,model=?,pending_kind=?,pending_request_id=?,notice_state=?,notice_key=?,known_turn_ids_json=?,known_message_ids_json=? WHERE id=?",
				)
				.run(
					next.ownerAgentId,
					next.threadId,
					next.status,
					next.revision,
					next.updatedAt,
					next.lastTurnId,
					next.lastError,
					next.source,
					next.model,
					next.pendingKind,
					next.pendingRequestId,
					next.noticeState,
					next.noticeKey,
					JSON.stringify(next.knownTurnIds),
					JSON.stringify(next.knownMessageIds),
					id,
				);
		});
		return this.require(id);
	}

	private tx(fn: () => void): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			fn();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
