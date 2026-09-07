import type { Static, TSchema } from "typebox";
import type { PermissionResolver } from "./approval-policy.ts";
import type { StreamEvent } from "./broadcast/activity.ts";
import type { ContextServices } from "./context/port.ts";
import type { ModelSettings } from "./models/types.ts";

export type LinaToolResult = {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
	>;
	details: unknown;
};
export type LinaContext = { signal?: AbortSignal; cwd: string };

/** Lina owns the tool contract; native adapters validate inputs at their boundary. */
export interface LinaTool<T extends TSchema = TSchema> {
	name: string;
	label: string;
	description: string;
	parameters: T;
	execute(
		callId: string,
		input: Static<T>,
		signal: AbortSignal | undefined,
		update?: (result: LinaToolResult) => void,
		context?: LinaContext,
	): Promise<LinaToolResult> | LinaToolResult;
}

type ToolIdentity = { toolCallId: string; toolName: string };
export type LinaEvents = {
	before_agent_start: { prompt: string; systemPrompt?: string };
	context: { messages: readonly unknown[] };
	agent_start: Record<string, unknown>;
	agent_end: Record<string, unknown>;
	agent_settled: Record<string, unknown>;
	message_update: { assistantMessageEvent: StreamEvent };
	tool_execution_start: ToolIdentity & { args: unknown };
	tool_call: ToolIdentity & { input: unknown };
	tool_execution_update: ToolIdentity & { partialResult: unknown };
	tool_execution_end: ToolIdentity & { result: unknown; isError: boolean };
};
export interface LinaHost {
	registerTool<T extends TSchema>(tool: LinaTool<T>): void;
	on<K extends keyof LinaEvents>(
		event: K,
		handler: (event: LinaEvents[K], context: LinaContext) => unknown,
	): void;
	sendUserMessage(
		content: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
}

/** Shared session construction input, independent of any engine SDK. */
export type SdkSessionOptions = {
	readonly agentId?: string;
	readonly modelSettings?: () => ModelSettings;
	readonly workspace: string;
	readonly sessionFile: string;
	readonly agentDir: string;
	readonly systemPrompt: string;
	readonly tools?: string[];
	readonly keepRecentTokens?: number;
	readonly contextBudget?: number;
	readonly register?: (
		host: LinaHost,
		services: ContextServices,
		permissions: PermissionResolver,
	) => void;
	readonly onError?: (message: string) => void;
};
