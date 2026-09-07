export const MAX_CHAT_LENGTH = 16_000;
export type ChatFrame = {
	readonly type: "chat";
	readonly id: string;
	readonly text: string;
};
export type ServerFrame =
	| ContextServer
	| ControlServer
	| WireServer
	| { readonly type: "ack"; readonly id: string }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "agent-text" | "agent-thinking"; readonly text: string }
	| { readonly type: "agent-status"; readonly state: "running" | "idle" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw !== "string" || raw.length > 1_048_576) return;
	try {
		const value: unknown = JSON.parse(raw);
		if (isRecord(value)) return value;
	} catch {
		/* Invalid network frames carry no trusted data. */
	}
	return;
}

export function parseChat(raw: unknown): ChatFrame | undefined {
	const value = parseWireClient(raw);
	return value?.type === "chat" ? value : undefined;
}

export function parseServerFrame(raw: unknown): ServerFrame | undefined {
	const context = parseContextServer(raw);
	if (context) return context;
	const control = parseControlServer(raw);
	if (control) return control;
	const durable = parseWireServer(raw);
	if (durable) return durable;
	const value = record(raw);
	if (value === undefined) return;
	const { type, id, message, text, state } = value;
	switch (type) {
		case "ack":
			return typeof id === "string" && id.length > 0
				? { type: "ack", id }
				: undefined;
		case "error":
			return typeof message === "string"
				? { type: "error", message }
				: undefined;
		case "agent-text":
		case "agent-thinking":
			return typeof text === "string" ? { type, text } : undefined;
		case "agent-status":
			return state === "idle" || state === "running"
				? { type: "agent-status", state }
				: undefined;
		default:
			return;
	}
}

import {
	type ContextServer,
	parseContextServer,
} from "../../lina-core/src/context-wire.ts";
import {
	type ControlServer,
	parseControlServer,
} from "../../lina-core/src/control-wire.ts";
import {
	parseWireClient,
	parseWireServer,
	type WireServer,
} from "../../lina-core/src/wire.ts";
