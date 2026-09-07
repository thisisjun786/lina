import type { DurableStore } from "../../lina-core/src/index.ts";
import type {
	BotBinding,
	SessionSnapshot,
} from "../../lina-core/src/protocol.ts";

/** Public snapshots have their own budget; the journal retains original request text. */
export function sessionSnapshot(
	store: DurableStore,
	binding: BotBinding,
	running: boolean,
): SessionSnapshot {
	return {
		version: 2,
		botId: binding.botId,
		sessionId: binding.sessionId,
		revision: store.revision(),
		state: running ? "running" : "idle",
		...store.conversationHistory(),
		requests: store.requests().map((request) => ({
			...request,
			text: request.text.slice(0, 4096),
			...(request.error ? { error: request.error.slice(0, 1024) } : {}),
		})),
	};
}
