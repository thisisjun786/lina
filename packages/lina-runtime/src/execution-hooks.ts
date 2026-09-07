import type { ExecutionCoordinator } from "./execution.ts";
import type { LinaHost } from "./host.ts";

export function installExecutionHooks(
	host: LinaHost,
	execution: ExecutionCoordinator,
): void {
	host.on("tool_execution_start", (event) => {
		execution.begin(event.toolCallId, event.toolName, event.args);
	});
	host.on("tool_call", async (event, context) => {
		const decision = await execution.authorize(
			event.toolCallId,
			event.toolName,
			event.input,
			context.signal,
		);
		return decision.allow
			? undefined
			: {
					block: true,
					reason: decision.reason ?? "Permission was not granted",
				};
	});
	host.on("tool_execution_update", (event) => {
		execution.update(event.toolCallId, event.partialResult);
	});
	host.on("tool_execution_end", (event) => {
		execution.end(event.toolCallId, event.result, event.isError);
	});
	host.on("agent_settled", () => {
		execution.settled();
	});
}
