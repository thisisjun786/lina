import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export const LINA_THREAD_SOURCE = "lina";
export const LINA_TURN_TRIGGER = "lina";

export const CODEX_METHODS = {
	threadStart: "thread/start",
	threadRead: "thread/read",
	threadResume: "thread/resume",
	threadNameSet: "thread/name/set",
	threadTurnsList: "thread/turns/list",
	turnStart: "turn/start",
	turnSteer: "turn/steer",
	turnInterrupt: "turn/interrupt",
} as const;

export type TextUserInput = {
	type: "text";
	text: string;
	text_elements: [];
};

export function textInput(text: string): TextUserInput {
	return { type: "text", text, text_elements: [] };
}

export function threadStartParams(input: {
	cwd: string;
	model?: string;
	dynamicTools?: Array<{
		type: "function";
		name: string;
		description: string;
		inputSchema: unknown;
	}>;
}): {
	cwd: string;
	approvalPolicy: "on-request";
	sandbox: "workspace-write";
	threadSource: string;
	model?: string;
	dynamicTools?: Array<{
		type: "function";
		name: string;
		description: string;
		inputSchema: unknown;
	}>;
} {
	const params: {
		cwd: string;
		approvalPolicy: "on-request";
		sandbox: "workspace-write";
		threadSource: string;
		model?: string;
		dynamicTools?: Array<{
			type: "function";
			name: string;
			description: string;
			inputSchema: unknown;
		}>;
	} = {
		cwd: input.cwd,
		approvalPolicy: "on-request",
		sandbox: "workspace-write",
		threadSource: LINA_THREAD_SOURCE,
	};
	if (input.model !== undefined) params.model = input.model;
	if (input.dynamicTools && input.dynamicTools.length > 0)
		params.dynamicTools = input.dynamicTools;
	return params;
}

export function turnStartParams(input: {
	threadId: string;
	text: string;
	requestId: string;
	model?: string;
}): {
	threadId: string;
	input: TextUserInput[];
	clientUserMessageId: string;
	turnTrigger: string;
	model?: string;
} {
	const params: {
		threadId: string;
		input: TextUserInput[];
		clientUserMessageId: string;
		turnTrigger: string;
		model?: string;
	} = {
		threadId: input.threadId,
		input: [textInput(input.text)],
		clientUserMessageId: input.requestId,
		turnTrigger: LINA_TURN_TRIGGER,
	};
	if (input.model !== undefined) params.model = input.model;
	return params;
}

export function turnSteerParams(input: {
	threadId: string;
	text: string;
	requestId: string;
	expectedTurnId: string;
}): {
	threadId: string;
	input: TextUserInput[];
	clientUserMessageId: string;
	expectedTurnId: string;
} {
	return {
		threadId: input.threadId,
		input: [textInput(input.text)],
		clientUserMessageId: input.requestId,
		expectedTurnId: input.expectedTurnId,
	};
}

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value as object)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}

export function createDigest(input: {
	ownerAgentId: string;
	title: string;
	cwd: string;
	prompt: string;
	model: string | null;
}): string {
	return canonical(input);
}

export function messageDigest(input: { taskId: string; text: string }): string {
	return canonical(input);
}

export function threadIdFromParams(params: unknown): string | null {
	if (!params || typeof params !== "object" || Array.isArray(params))
		return null;
	const record = params as Record<string, unknown>;
	if (typeof record["threadId"] === "string") return record["threadId"];
	if (typeof record["conversationId"] === "string")
		return record["conversationId"];
	return null;
}
