import type { EntryInput } from "../../lina-core/src/protocol.ts";
import { developmentNotice } from "./development/notices.ts";

export type NativeEvent =
	| { type: "entry"; entry: EntryInput }
	| { type: "text"; delta: string }
	| { type: "text-end"; text: string }
	| { type: "start" | "settled" }
	| { type: "failure"; error: string };

type NativeFields = Partial<
	Record<
		| "id"
		| "timestamp"
		| "type"
		| "message"
		| "role"
		| "content"
		| "text"
		| "assistantMessageEvent"
		| "delta"
		| "stopReason"
		| "errorMessage"
		| "entry",
		unknown
	>
>;

function record(value: unknown): NativeFields | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as NativeFields)
		: undefined;
}

/** Deliberately exclude thinking, signatures and tool input from presentation text. */
function visibleText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item: unknown) => {
			const block = record(item);
			return block?.type === "text" && typeof block.text === "string"
				? [block.text]
				: [];
		})
		.join("\n\n");
}

export function projectNativeEntry(raw: unknown): EntryInput | undefined {
	const entry = record(raw);
	if (
		!entry ||
		typeof entry.id !== "string" ||
		typeof entry.timestamp !== "string" ||
		typeof entry.type !== "string"
	)
		return;
	const notice = developmentNotice(raw);
	if (notice)
		return {
			entryId: entry.id,
			role: "assistant",
			text: notice.text,
			timestamp: entry.timestamp,
			raw,
		};
	const message = entry.type === "message" ? record(entry.message) : undefined;
	const nativeRole = message?.role;
	const role =
		nativeRole === "user" || nativeRole === "assistant"
			? nativeRole
			: nativeRole === "toolResult"
				? "tool"
				: "meta";
	return {
		entryId: entry.id,
		role,
		text: visibleText(message?.content),
		timestamp: entry.timestamp,
		raw,
	};
}

export function decodeNativeEvent(raw: unknown): NativeEvent | undefined {
	const event = record(raw);
	if (!event) return;
	switch (event.type) {
		case "entry_appended": {
			const entry = projectNativeEntry(event.entry);
			return entry ? { type: "entry", entry } : undefined;
		}
		case "message_update": {
			const part = record(event.assistantMessageEvent);
			if (part?.type === "text_delta" && typeof part.delta === "string")
				return { type: "text", delta: part.delta };
			if (part?.type === "text_end" && typeof part.content === "string")
				return { type: "text-end", text: part.content };
			return;
		}
		case "message_end": {
			const message = record(event.message);
			if (
				message?.role === "assistant" &&
				(message.stopReason === "error" || message.stopReason === "aborted")
			)
				return {
					type: "failure",
					error:
						typeof message.errorMessage === "string"
							? message.errorMessage
							: "Run interrupted",
				};
			return;
		}
		case "continuation_error":
			return {
				type: "failure",
				error:
					typeof event.errorMessage === "string"
						? event.errorMessage
						: "Continuation failed",
			};
		case "agent_start":
			return { type: "start" };
		case "agent_settled":
			return { type: "settled" };
		default:
			return;
	}
}
