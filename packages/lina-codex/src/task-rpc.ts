export type TaskNotification = {
	method: string;
	params: unknown;
};

export type TaskServerRequest = {
	id: string | number;
	method: string;
	params: unknown;
};

export const TASK_APPROVAL_METHODS = [
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
] as const;

export function isTaskApprovalMethod(method: string): boolean {
	return (TASK_APPROVAL_METHODS as readonly string[]).includes(method);
}

/**
 * Injected Codex app-server JSON-RPC port.
 * fleet/task-transport.ts implements request, subscribe({method,params}),
 * subscribeRequests, and respond. Main owns the shared daemon proxy;
 * this manager never starts or restarts it.
 */
export type TaskRpc = {
	request<T>(
		method: string,
		params?: unknown,
		signal?: AbortSignal,
	): Promise<T>;
	subscribe(listener: (notification: TaskNotification) => void): () => void;
	subscribeRequests?(
		listener: (request: TaskServerRequest) => void,
	): () => void;
	respond?(id: string | number, result: unknown): Promise<void>;
};

export type TaskDynamicTool = {
	type: "function";
	name: string;
	description: string;
	inputSchema: unknown;
};

export type TaskToolResult = {
	contentItems: Array<{ type: "inputText"; text: string }>;
	success: boolean;
};

export type TaskManagerOptions = {
	path: string;
	rpc: TaskRpc;
	now?: () => string;
	id?: () => string;
	dynamicTools?: TaskDynamicTool[];
	executeTool?: (
		tool: string,
		callId: string,
		args: unknown,
		signal: AbortSignal,
	) => Promise<TaskToolResult>;
};
