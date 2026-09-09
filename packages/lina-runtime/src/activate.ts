import type { ContextStore } from "../../lina-core/src/context/store.ts";
import { activityFrame } from "./broadcast/activity.ts";
import type { LinaHost } from "./host.ts";
import { AgentRunState } from "./intervention/protocol.ts";
import { startInterventionServer } from "./intervention/ws-server.ts";
import { createNotepadTools } from "./tools/notepad.ts";
import { createStatusTool } from "./tools/status.ts";
import { installIdleNudge } from "./watcher/idle-nudge.ts";

export type ActivateOptions = {
	readonly interventionPort: number;
	/** 0 disables the idle nudge. */
	readonly idleTimeoutMs: number;
	readonly dataDir: string;
	readonly notepad: {
		store: ContextStore;
		activeRequestId: () => string | undefined;
	};
};

export interface LinaRuntime {
	readonly interventionPort: number;
	stop(): Promise<void>;
}

export const IDLE_NUDGE_TEXT =
	"AUTOMATED NUDGE: you went idle. Read lina_notepad_read, pick the next open item, and act on it now.";

export async function activate(
	pi: LinaHost,
	options: ActivateOptions,
): Promise<LinaRuntime> {
	if (!options.notepad || typeof options.notepad.activeRequestId !== "function")
		throw Error("Managed notepad context is required");
	const startedAt = new Date().toISOString();
	let lastAgentEndAt: string | undefined;
	let state: AgentRunState = AgentRunState.idle;

	const notepad = createNotepadTools(
		options.notepad.store,
		options.notepad.activeRequestId,
	);
	pi.registerTool(notepad.read);
	pi.registerTool(notepad.append);
	pi.registerTool(
		createStatusTool(() => ({
			startedAt,
			interventionPort: server.port,
			lastAgentEndAt,
		})),
	);

	const server = await startInterventionServer({
		port: options.interventionPort,
		sink: pi,
		currentStatus: () => state,
	});

	pi.on("message_update", (event) => {
		const frame = activityFrame(event.assistantMessageEvent);
		if (frame !== undefined) server.broadcast(frame);
	});
	pi.on("agent_start", () => {
		state = AgentRunState.running;
		server.broadcast({ type: "agent-status", state });
	});
	pi.on("agent_end", () => {
		state = AgentRunState.idle;
		lastAgentEndAt = new Date().toISOString();
		server.broadcast({ type: "agent-status", state });
	});

	const nudge =
		options.idleTimeoutMs > 0
			? installIdleNudge(
					{
						on(event, handler) {
							if (event === "agent_start") pi.on("agent_start", handler);
							else pi.on("agent_end", handler);
						},
						sendUserMessage: (content, opts) =>
							pi.sendUserMessage(content, opts),
					},
					{ idleTimeoutMs: options.idleTimeoutMs, nudgeText: IDLE_NUDGE_TEXT },
				)
			: undefined;

	console.error(
		`[lina] registered tools: ${[notepad.read.name, notepad.append.name, "lina_status"].join(",")}; intervention ws :${server.port}`,
	);
	return {
		interventionPort: server.port,
		async stop() {
			nudge?.stop();
			await server.stop();
		},
	};
}
