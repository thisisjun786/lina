import type { OutboundFrame } from "../intervention/protocol.ts";

/** Shape shared by every native assistant-message stream event we care about. */
export type StreamEvent = { readonly type: string; readonly content?: unknown };

/** Map a native `message_update` stream event to a viewer frame; only *_end boundaries become rows. */
export function activityFrame(event: StreamEvent): OutboundFrame | undefined {
	if (typeof event.content !== "string") return undefined;
	const text = event.content.trim();
	if (text.length === 0) return undefined;
	if (event.type === "text_end") return { type: "agent-text", text };
	if (event.type === "thinking_end") return { type: "agent-thinking", text };
	return undefined;
}
