import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { PermissionResolver } from "../../lina-runtime/src/approval-policy.ts";
import type { LinaHost, LinaTool } from "../../lina-runtime/src/host.ts";

type Handler = (event: never, context: never) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonSchemaOf(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return { type: "object", properties: {} };
	const schema: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (key.startsWith("$")) continue;
		schema[key] = item;
	}
	if (schema["type"] === undefined) schema["type"] = "object";
	return schema;
}

export function validateToolArguments(
	schema: Record<string, unknown>,
	args: unknown,
): Record<string, unknown> {
	const input = args === undefined || args === null ? {} : args;
	if (!isRecord(input)) throw new Error("Tool arguments must be an object");
	const type = Type.Unsafe<Record<string, unknown>>(schema as TSchema);
	if (!Value.Check(type, input)) throw new Error("Invalid tool arguments");
	return input;
}

function toolText(result: unknown): string {
	if (!isRecord(result) || !Array.isArray(result["content"]))
		return typeof result === "string" ? result : JSON.stringify(result ?? "");
	return result["content"]
		.flatMap((item) => {
			const block = isRecord(item) ? item : undefined;
			return block?.["type"] === "text" && typeof block["text"] === "string"
				? [block["text"]]
				: [];
		})
		.join("\n");
}

export class CodexHost {
	readonly tools = new Map<string, LinaTool>();
	private readonly handlers = new Map<string, Handler[]>();
	constructor(
		private readonly workspace: string,
		readonly permissions: PermissionResolver,
	) {}

	asLinaHost(): LinaHost {
		return this as unknown as LinaHost;
	}

	registerTool(tool: LinaTool): void {
		this.tools.set(tool.name, tool);
	}

	on(event: string, handler: Handler): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}

	sendUserMessage(): void {
		undefined;
	}

	async emit(
		event: string,
		payload: unknown,
		signal: AbortSignal,
	): Promise<unknown> {
		let result: unknown;
		for (const handler of this.handlers.get(event) ?? []) {
			const value = await (
				handler as (event: unknown, context: unknown) => unknown
			)(payload, { signal, cwd: this.workspace });
			if (value !== undefined) result = value;
		}
		return result;
	}

	async beforeTurn(
		prompt: string,
		signal: AbortSignal,
	): Promise<{
		systemPrompt?: string;
		context?: string;
	}> {
		const before = await this.emit(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt,
				systemPrompt: "",
				systemPromptOptions: {},
			},
			signal,
		);
		const context = await this.emit(
			"context",
			{
				type: "context",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			signal,
		);
		const systemPrompt =
			isRecord(before) && typeof before["systemPrompt"] === "string"
				? before["systemPrompt"]
				: undefined;
		const messages =
			isRecord(context) && Array.isArray(context["messages"])
				? context["messages"]
				: [];
		const injected = messages.flatMap((message) => {
			if (
				!isRecord(message) ||
				message["customType"] !== "lina-context-reference"
			)
				return [];
			return typeof message["content"] === "string" ? [message["content"]] : [];
		});
		return {
			...(systemPrompt ? { systemPrompt } : {}),
			...(injected[0] ? { context: injected[0] } : {}),
		};
	}

	async invokeTool(
		name: string,
		callId: string,
		args: unknown,
		signal: AbortSignal,
	): Promise<{
		contentItems: Array<{ type: "inputText"; text: string }>;
		success: boolean;
	}> {
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`Unknown Lina tool: ${name}`);
		const params = validateToolArguments(jsonSchemaOf(tool.parameters), args);
		await this.emit(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: name,
				args: params,
			},
			signal,
		);
		const decision = await this.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: callId, toolName: name, input: params },
			signal,
		);
		if (isRecord(decision) && decision["block"]) {
			const reason =
				typeof decision["reason"] === "string"
					? decision["reason"]
					: "Permission was not granted";
			await this.emit(
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: name,
					result: reason,
					isError: true,
				},
				signal,
			);
			return {
				contentItems: [{ type: "inputText", text: reason }],
				success: false,
			};
		}
		try {
			const result = await tool.execute(
				callId,
				params as never,
				signal,
				undefined,
				{
					signal,
					cwd: this.workspace,
				} as never,
			);
			await this.emit(
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: name,
					result,
					isError: false,
				},
				signal,
			);
			return {
				contentItems: [{ type: "inputText", text: toolText(result) || "ok" }],
				success: true,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : "Tool failed";
			await this.emit(
				"tool_execution_end",
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: name,
					result: message,
					isError: true,
				},
				signal,
			);
			return {
				contentItems: [{ type: "inputText", text: message }],
				success: false,
			};
		}
	}

	async authorizeNative(
		name: string,
		callId: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<boolean> {
		await this.emit(
			"tool_execution_start",
			{
				type: "tool_execution_start",
				toolCallId: callId,
				toolName: name,
				args: input,
			},
			signal,
		);
		const decision = await this.emit(
			"tool_call",
			{ type: "tool_call", toolCallId: callId, toolName: name, input },
			signal,
		);
		const handlers = this.handlers.get("tool_call") ?? [];
		const allow =
			handlers.length > 0 && !(isRecord(decision) && decision["block"]);
		await this.emit(
			"tool_execution_end",
			{
				type: "tool_execution_end",
				toolCallId: callId,
				toolName: name,
				result: allow ? "accepted" : "denied",
				isError: !allow,
			},
			signal,
		);
		return allow;
	}
}
