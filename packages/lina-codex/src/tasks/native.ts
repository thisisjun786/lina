import { TaskError, type TaskThread, type TaskTurn } from "../task-types.ts";

function record(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function wrapNativeError(error: unknown): TaskError {
	if (error instanceof TaskError) return error;
	return new TaskError("native_unavailable", errorMessage(error));
}

export function isArchivedError(error: unknown): boolean {
	return /archiv|deleted/i.test(errorMessage(error));
}

export function parseThreadId(result: unknown): string {
	const body = record(result);
	const thread = body ? (record(body["thread"]) ?? body) : null;
	const id = thread?.["id"];
	if (typeof id !== "string" || id.length === 0)
		throw new TaskError(
			"native_unavailable",
			"thread/start did not return a native thread id",
		);
	return id;
}

export function parseTurnId(result: unknown): string | null {
	const body = record(result);
	if (!body) return null;
	if (typeof body["turnId"] === "string") return body["turnId"];
	const turn = record(body["turn"]);
	return typeof turn?.["id"] === "string" ? turn["id"] : null;
}

export function parseModel(result: unknown): string | null {
	const body = record(result);
	if (typeof body?.["model"] === "string") return body["model"];
	const thread = record(body?.["thread"]);
	return typeof thread?.["model"] === "string" ? thread["model"] : null;
}

function parseTurn(value: unknown): TaskTurn | null {
	const turn = record(value);
	if (!turn || typeof turn["id"] !== "string") return null;
	return {
		id: turn["id"],
		status: typeof turn["status"] === "string" ? turn["status"] : "unknown",
		items: Array.isArray(turn["items"]) ? turn["items"] : [],
		startedAt: typeof turn["startedAt"] === "number" ? turn["startedAt"] : null,
		completedAt:
			typeof turn["completedAt"] === "number" ? turn["completedAt"] : null,
		error: turn["error"] ?? null,
	};
}

export function parseThread(result: unknown): TaskThread {
	const body = record(result);
	const thread = body ? (record(body["thread"]) ?? body) : null;
	if (!thread || typeof thread["id"] !== "string")
		throw new TaskError(
			"native_unavailable",
			"native thread payload was missing",
		);
	const turns = Array.isArray(thread["turns"])
		? thread["turns"].map(parseTurn).filter((turn) => turn !== null)
		: [];
	return {
		id: thread["id"],
		sessionId:
			typeof thread["sessionId"] === "string" ? thread["sessionId"] : null,
		model: typeof thread["model"] === "string" ? thread["model"] : null,
		cwd: typeof thread["cwd"] === "string" ? thread["cwd"] : "",
		status: thread["status"] ?? null,
		source: thread["source"] ?? thread["threadSource"] ?? null,
		name: typeof thread["name"] === "string" ? thread["name"] : null,
		preview: typeof thread["preview"] === "string" ? thread["preview"] : null,
		turns,
		canAcceptDirectInput:
			typeof thread["canAcceptDirectInput"] === "boolean"
				? thread["canAcceptDirectInput"]
				: null,
	};
}

export function parseTurnsPage(result: unknown): TaskTurn[] {
	const body = record(result);
	const data = body?.["data"];
	if (!Array.isArray(data)) return [];
	return data.map(parseTurn).filter((turn) => turn !== null);
}

export function threadStatusType(status: unknown): string | null {
	const body = record(status);
	return typeof body?.["type"] === "string" ? body["type"] : null;
}

export function mapThreadStatus(status: unknown): string {
	const body = record(status);
	const type = typeof body?.["type"] === "string" ? body["type"] : null;
	if (type === "idle") return "idle";
	if (type === "notLoaded") return "needs_attention";
	if (type === "systemError") return "failed";
	if (type === "active") {
		const flags = Array.isArray(body?.["activeFlags"])
			? body["activeFlags"]
			: [];
		if (flags.includes("waitingOnApproval")) return "waiting_approval";
		if (flags.includes("waitingOnUserInput")) return "waiting_input";
		return "running";
	}
	if (type && type.length <= 64) return type;
	return "needs_attention";
}

export function activeTurnId(thread: TaskThread): string | null {
	for (const turn of thread.turns) {
		if (turn.status === "inProgress") return turn.id;
	}
	return null;
}

export function hasExternalUserInput(
	thread: TaskThread,
	knownMessageIds: ReadonlySet<string>,
): boolean {
	for (const turn of thread.turns) {
		for (const item of turn.items) {
			const body = record(item);
			if (body?.["type"] !== "userMessage") continue;
			const clientId = body["clientId"];
			if (typeof clientId !== "string" || !knownMessageIds.has(clientId))
				return true;
		}
	}
	return false;
}

export function notificationThreadId(
	method: string,
	params: unknown,
): string | null {
	const body = record(params);
	if (!body) return null;
	if (typeof body["threadId"] === "string") return body["threadId"];
	if (method === "thread/started") {
		const thread = record(body["thread"]);
		if (typeof thread?.["id"] === "string") return thread["id"];
	}
	if (method === "turn/completed") {
		const turn = record(body["turn"]);
		if (typeof body["threadId"] === "string") return body["threadId"];
		if (
			typeof turn?.["id"] === "string" &&
			typeof body["threadId"] === "string"
		)
			return body["threadId"];
	}
	return typeof body["threadId"] === "string" ? body["threadId"] : null;
}

export function notificationTurn(
	params: unknown,
): { id: string; status: string } | null {
	const body = record(params);
	const turn = record(body?.["turn"]);
	if (!turn || typeof turn["id"] !== "string") return null;
	return {
		id: turn["id"],
		status: typeof turn["status"] === "string" ? turn["status"] : "unknown",
	};
}

export function approvalDecisionResult(
	method: string,
	decision: "accept" | "decline" | "cancel" | "acceptForSession",
): unknown {
	if (
		method === "item/commandExecution/requestApproval" ||
		method === "item/fileChange/requestApproval"
	)
		return { decision };
	if (method === "execCommandApproval" || method === "applyPatchApproval") {
		const mapped =
			decision === "accept"
				? "approved"
				: decision === "acceptForSession"
					? "approved_for_session"
					: decision === "cancel"
						? "abort"
						: { denied: { rejection: "declined by Lina operator" } };
		return { decision: mapped };
	}
	throw new TaskError(
		"approval_unavailable",
		"this approval kind cannot be answered with a generic decision; refusing to auto-approve",
	);
}
