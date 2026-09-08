import type { LinaHost } from "../host.ts";
import type { ContextCoordinator } from "./coordinator.ts";

export function installContextHooks(
	host: LinaHost,
	coordinator: ContextCoordinator,
	recall: (query: string, signal?: AbortSignal) => Promise<string>,
	currentRecall: () => string = () => "",
): void {
	host.on("agent_settled", () => {
		coordinator.settled();
	});
	host.on("before_agent_start", async (event, context) => {
		if (!context.signal)
			throw Error("Codex turn cancellation signal is missing");
		await coordinator.refreshExternal(context.signal);
		try {
			coordinator.setRecall(
				await recall(event.prompt, context.signal),
				currentRecall,
			);
		} catch {
			coordinator.setRecall("");
		}
	});
	host.on("context", (event) => {
		const { content, beforeDeliver } = coordinator.readInjection(
			event.messages,
		);
		if (!content) return;
		return {
			beforeDeliver,
			messages: [
				{
					role: "custom",
					customType: "lina-context-reference",
					display: false,
					content,
					timestamp: 0,
				},
				...event.messages,
			],
		};
	});
}
