/**
 * Wire contract of the lina-runtime intervention socket, mirrored here because
 * lina-channels never imports lina-runtime. Field names must stay identical to
 * packages/lina-runtime/src/intervention/protocol.ts.
 */
import { z } from "zod";

export const AGENT_RUN_STATES = ["running", "idle"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

/** Everything the agent broadcasts out; parsed at the socket boundary. */
export const OutboundFrameSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ack"), id: z.string().min(1) }),
	z.object({ type: z.literal("error"), message: z.string() }),
	z.object({ type: z.literal("agent-text"), text: z.string() }),
	z.object({ type: z.literal("agent-thinking"), text: z.string() }),
	z.object({
		type: z.literal("agent-status"),
		state: z.enum(AGENT_RUN_STATES),
	}),
]);

export type OutboundFrame = Readonly<z.infer<typeof OutboundFrameSchema>>;

/**
 * The only frame the bridge sends in. `id` is always present and non-empty:
 * acks echo it, and error frames carry none, so it is the only correlation key.
 */
export type ChatFrame = {
	readonly type: "chat";
	readonly id: string;
	readonly text: string;
};

export function assertNever(value: never): never {
	throw new Error(`unreachable: ${JSON.stringify(value)}`);
}

/** Decoding outcome; `ignored` carries the reason so the caller can log it. */
export type FrameDecode =
	| { readonly kind: "frame"; readonly frame: OutboundFrame }
	| { readonly kind: "ignored"; readonly reason: string };

const decoder = new TextDecoder();

function payloadText(payload: unknown): string | undefined {
	// `ws` delivers a MessageEvent, Bun's client the raw payload; unwrap both.
	const data =
		typeof payload === "object" && payload !== null && "data" in payload
			? payload.data
			: payload;
	if (typeof data === "string") return data;
	if (data instanceof Uint8Array || data instanceof ArrayBuffer)
		return decoder.decode(data);
	return undefined;
}

/** The socket boundary: a raw payload becomes a typed frame here or nothing at all. */
export function decodeOutboundFrame(payload: unknown): FrameDecode {
	const text = payloadText(payload);
	if (text === undefined)
		return { kind: "ignored", reason: "a frame that is not utf-8 text" };
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError)
			return { kind: "ignored", reason: `invalid json: ${text}` };
		throw error;
	}
	const parsed = OutboundFrameSchema.safeParse(json);
	return parsed.success
		? { kind: "frame", frame: parsed.data }
		: { kind: "ignored", reason: `unknown frame: ${text}` };
}
