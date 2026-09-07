export const CONTROL_PREVIEW_MAX_CHARS = 2048;
export const CONTROL_INPUT_MAX_CHARS = 65536;
export const CONTROL_TOOL_LIMIT = 40;
export const CONTROL_PENDING_LIMIT = 8;
export const CONTROL_DECISION_LIMIT = 8;
export const APPROVAL_TTL_MS = 5 * 60 * 1000;

export type ToolState =
	| "preparing"
	| "waiting_approval"
	| "ready"
	| "running"
	| "succeeded"
	| "failed"
	| "blocked"
	| "interrupted";

export interface ToolRun {
	id: string;
	nativeCallId: string;
	requestId: string;
	name: string;
	state: ToolState;
	inputPreview: string;
	outputPreview: string;
	createdAt: string;
	updatedAt: string;
}

export type ApprovalState =
	| "pending"
	| "allowed"
	| "denied"
	| "expired"
	| "aborted";
export interface Approval {
	id: string;
	toolRunId: string;
	inputDigest: string;
	inputJson: string;
	state: ApprovalState;
	expiresAt: number;
	createdAt: string;
}

export interface ControlSnapshot {
	sessionId: string;
	revision: number;
	tools: ToolRun[];
	approvals: Approval[];
	cancelling: boolean;
	cancelFailed: boolean;
	cancelRequestId: string | null;
}

export interface Authorization {
	allow: boolean;
	reason?: string;
}
export interface ControlStoreOptions {
	now?: () => number;
}
export interface ApprovalGateOptions {
	now?: () => number;
	/** Schedule once and return an idempotent cancellation function. */
	schedule?: (callback: () => void, delayMs: number) => () => void;
}
