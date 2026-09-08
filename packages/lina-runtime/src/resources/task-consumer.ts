import { CodexHost } from "../../../lina-codex/src/host.ts";
import type {
	TaskManagerOptions,
	TaskToolContext,
} from "../../../lina-codex/src/task-rpc.ts";
import type { ResourceStore } from "../../../lina-memory/src/resources/store.ts";
import type { ResourceScope } from "../../../lina-memory/src/resources/types.ts";
import { installResourceTools } from "./tools.ts";
/** Host-owned consumer factory, independent of task creation or coding activity. */
export function resourceTaskConsumer(options: {
	root: string;
	store: ResourceStore;
	scopeForAgent: (agentId: string) => ResourceScope;
	sharedScope: () => ResourceScope;
}): NonNullable<TaskManagerOptions["executeTool"]> {
	return async (tool, callId, args, signal, context?: TaskToolContext) => {
		const scope = () => {
			context?.assertCurrent();
			const value = context?.agentId
				? options.scopeForAgent(context.agentId)
				: options.sharedScope();
			if (
				!context?.agentId &&
				(value.agentId !== null ||
					value.allowedVisibilities.includes("private"))
			)
				throw Error("unattributed resource scope must be shared-only");
			return value;
		};
		const host = new CodexHost(options.root, () => ({ action: "allow" }));
		installResourceTools(host.asLinaHost(), { store: options.store, scope });
		scope();
		const result = await host.invokeTool(tool, callId, args, signal);
		context?.assertCurrent();
		return result;
	};
}
