import type { Approval, ControlSnapshot, ToolRun } from "./control/types.ts";

export type ControlClient =
	| {
			type: "approval_reply";
			sessionId: string;
			id: string;
			inputDigest: string;
			decision: "allow" | "deny";
	  }
	| { type: "cancel"; sessionId: string; requestId: string };
export type ControlServer =
	| { type: "control-state"; state: ControlSnapshot }
	| {
			type: "control-error";
			operation: "approval" | "cancel" | "runtime";
			message: string;
	  };
type Fields = Partial<
	Record<
		| "type"
		| "sessionId"
		| "id"
		| "inputDigest"
		| "decision"
		| "requestId"
		| "state"
		| "revision"
		| "tools"
		| "approvals"
		| "cancelling"
		| "cancelFailed"
		| "cancelRequestId"
		| "nativeCallId"
		| "name"
		| "inputPreview"
		| "outputPreview"
		| "createdAt"
		| "updatedAt"
		| "toolRunId"
		| "inputJson"
		| "expiresAt"
		| "operation"
		| "message",
		unknown
	>
>;
function record(value: unknown): Fields | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Fields)
		: undefined;
}
function decode(raw: unknown): Fields | undefined {
	if (typeof raw !== "string" || raw.length > 4_194_304) return;
	try {
		return record(JSON.parse(raw));
	} catch {
		return;
	}
}
function id(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function string(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}
function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseControlClient(raw: unknown): ControlClient | undefined {
	const value = decode(raw);
	if (!value || !id(value.sessionId)) return;
	if (
		value.type === "cancel" &&
		id(value.requestId) &&
		Object.keys(value).length === 3
	)
		return {
			type: "cancel",
			sessionId: value.sessionId,
			requestId: value.requestId,
		};
	if (
		value.type === "approval_reply" &&
		id(value.id) &&
		digest(value.inputDigest) &&
		(value.decision === "allow" || value.decision === "deny") &&
		Object.keys(value).length === 5
	)
		return {
			type: "approval_reply",
			sessionId: value.sessionId,
			id: value.id,
			inputDigest: value.inputDigest,
			decision: value.decision,
		};
	return;
}

function tool(raw: unknown): ToolRun | undefined {
	const value = record(raw);
	if (
		!value ||
		!id(value.id) ||
		!id(value.nativeCallId) ||
		!id(value.requestId) ||
		!id(value.name) ||
		!string(value.inputPreview, 2048) ||
		!string(value.outputPreview, 2048) ||
		!string(value.createdAt, 64) ||
		!string(value.updatedAt, 64)
	)
		return;
	const state = value.state;
	if (
		state !== "preparing" &&
		state !== "waiting_approval" &&
		state !== "ready" &&
		state !== "running" &&
		state !== "succeeded" &&
		state !== "failed" &&
		state !== "blocked" &&
		state !== "interrupted"
	)
		return;
	return {
		id: value.id,
		nativeCallId: value.nativeCallId,
		requestId: value.requestId,
		name: value.name,
		state,
		inputPreview: value.inputPreview,
		outputPreview: value.outputPreview,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}
function approval(raw: unknown): Approval | undefined {
	const value = record(raw);
	if (
		!value ||
		!id(value.id) ||
		!id(value.toolRunId) ||
		!digest(value.inputDigest) ||
		!string(value.inputJson, 65536) ||
		!integer(value.expiresAt) ||
		!string(value.createdAt, 64)
	)
		return;
	const state = value.state;
	if (
		state !== "pending" &&
		state !== "allowed" &&
		state !== "denied" &&
		state !== "expired" &&
		state !== "aborted"
	)
		return;
	try {
		JSON.parse(value.inputJson);
	} catch {
		return;
	}
	return {
		id: value.id,
		toolRunId: value.toolRunId,
		inputDigest: value.inputDigest,
		inputJson: value.inputJson,
		state,
		expiresAt: value.expiresAt,
		createdAt: value.createdAt,
	};
}
function snapshot(raw: unknown): ControlSnapshot | undefined {
	const value = record(raw);
	if (
		!value ||
		!id(value.sessionId) ||
		!integer(value.revision) ||
		typeof value.cancelling !== "boolean" ||
		typeof value.cancelFailed !== "boolean" ||
		(value.cancelRequestId !== null && !id(value.cancelRequestId)) ||
		!Array.isArray(value.tools) ||
		value.tools.length > 40 ||
		!Array.isArray(value.approvals) ||
		value.approvals.length > 16
	)
		return;
	const tools: ToolRun[] = [],
		approvals: Approval[] = [];
	for (const item of value.tools) {
		const parsed = tool(item);
		if (!parsed || tools.some((tool) => tool.id === parsed.id)) return;
		tools.push(parsed);
	}
	for (const item of value.approvals) {
		const parsed = approval(item);
		if (!parsed || approvals.some((approval) => approval.id === parsed.id))
			return;
		if (
			parsed.state === "pending" &&
			!tools.some(
				(tool) =>
					tool.id === parsed.toolRunId && tool.state === "waiting_approval",
			)
		)
			return;
		approvals.push(parsed);
	}
	if (approvals.filter((approval) => approval.state === "pending").length > 8)
		return;
	return {
		sessionId: value.sessionId,
		revision: value.revision,
		cancelling: value.cancelling,
		cancelFailed: value.cancelFailed,
		cancelRequestId: value.cancelRequestId,
		tools,
		approvals,
	};
}
export function parseControlServer(raw: unknown): ControlServer | undefined {
	const value = decode(raw);
	if (!value) return;
	if (value.type === "control-state") {
		const state = snapshot(value.state);
		return state ? { type: "control-state", state } : undefined;
	}
	if (
		value.type === "control-error" &&
		(value.operation === "approval" ||
			value.operation === "cancel" ||
			value.operation === "runtime") &&
		string(value.message, 2048)
	)
		return {
			type: "control-error",
			operation: value.operation,
			message: value.message,
		};
	return;
}
