export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const TASK_STATUSES = [
	"creating",
	"running",
	"idle",
	"waiting_approval",
	"waiting_input",
	"interrupted",
	"failed",
	"needs_attention",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskSource = "lina" | "external";

export type TaskSummary = {
	id: string;
	threadId: string | null;
	ownerAgentId: string;
	title: string;
	cwd: string;
	status: string;
	revision: number;
	updatedAt: string;
	model: string | null;
};

export type TaskApproval = {
	id: string;
	method: string;
	params: unknown;
	createdAt: string;
};

export type TaskTurn = {
	id: string;
	status: string;
	items: unknown[];
	startedAt: number | null;
	completedAt: number | null;
	error: unknown;
};

export type TaskThread = {
	id: string;
	sessionId: string | null;
	model: string | null;
	cwd: string;
	status: unknown;
	source: unknown;
	name: string | null;
	preview: string | null;
	turns: TaskTurn[];
	canAcceptDirectInput: boolean | null;
};

export type TaskRecord = TaskSummary & {
	createdAt: string;
	prompt: string;
	requestId: string;
	lastTurnId: string | null;
	lastError: string | null;
	source: TaskSource;
	pendingApprovals: TaskApproval[];
};

export type TaskListResult = {
	tasks: TaskSummary[];
};

export type TaskReadResult = {
	task: TaskRecord;
	thread: TaskThread | null;
};

export type CreateTaskInput = {
	ownerAgentId: string;
	title: string;
	cwd: string;
	prompt: string;
	requestId: string;
	model?: string;
};

export type MessageTaskInput = {
	text: string;
	requestId: string;
	expectedRevision: number;
};

export type HandoverTaskInput = {
	ownerAgentId: string;
	expectedRevision: number;
};

export type ReplyApprovalInput = {
	approvalId: string;
	decision: "accept" | "decline" | "cancel" | "acceptForSession";
	expectedRevision: number;
};

export type TaskNotice =
	| { type: "change"; task: TaskSummary; source: TaskSource }
	| { type: "completion"; task: TaskSummary; noticeKey: string };

export type TaskErrorCode =
	| "unauthorized"
	| "invalid_input"
	| "workspace"
	| "conflict"
	| "unknown_task"
	| "revision_mismatch"
	| "native_unavailable"
	| "native_archived"
	| "closed"
	| "approval_unavailable";

export class TaskError extends Error {
	readonly code: TaskErrorCode;
	constructor(code: TaskErrorCode, message: string) {
		super(message);
		this.name = "TaskError";
		this.code = code;
	}
}

export function isTaskError(value: unknown): value is TaskError {
	return value instanceof TaskError;
}
