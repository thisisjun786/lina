import { z } from "zod";

/** Frames a human (web chat, channel bridge) sends INTO the agent loop. Parsed at the socket boundary. */
export const InboundFrameSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("chat"),
		/** Client-chosen correlation id echoed back on the ack; generated server-side when absent. */
		id: z.string().min(1).optional(),
		text: z.string().min(1),
	}),
]);
export type InboundFrame = z.infer<typeof InboundFrameSchema>;

export const AgentRunState = { running: "running", idle: "idle" } as const;
export type AgentRunState = (typeof AgentRunState)[keyof typeof AgentRunState];

/** Frames the agent broadcasts OUT to every connected viewer. */
export type OutboundFrame =
	| { readonly type: "ack"; readonly id: string }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "agent-text"; readonly text: string }
	| { readonly type: "agent-thinking"; readonly text: string }
	| { readonly type: "agent-status"; readonly state: AgentRunState };

export function assertNever(value: never): never {
	throw new Error(`unreachable: ${JSON.stringify(value)}`);
}
