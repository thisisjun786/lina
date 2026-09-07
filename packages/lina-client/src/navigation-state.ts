export type Screen = "agents" | "conversation" | "tasks" | "settings";
export type NavigationState = {
	screen: Screen;
	agentId: string;
	taskId?: string;
};
const AGENT_ID = /^[a-z][a-z0-9-]{0,47}$/;

export function parseNavigation(href: string): NavigationState {
	const query = new URL(href).searchParams;
	const id = query.get("agent");
	const valid = id !== null && AGENT_ID.test(id);
	const screen = query.get("screen");
	const task = query.get("task");
	if (task && /^[a-zA-Z0-9_-]{1,128}$/.test(task))
		return { agentId: valid ? id : "lina", screen: "tasks", taskId: task };
	return {
		agentId: valid ? id : "lina",
		screen:
			screen === "agents" ||
			screen === "tasks" ||
			screen === "settings" ||
			screen === "conversation"
				? screen
				: valid
					? "conversation"
					: "agents",
	};
}

export function navigationUrl(state: NavigationState): string {
	return `/?agent=${encodeURIComponent(state.agentId)}&screen=${state.screen}${state.taskId ? `&task=${encodeURIComponent(state.taskId)}` : ""}`;
}

export function navigationLayout(
	width: number,
	expandedTasks: boolean,
	sidebarWidth: number,
): "mobile" | "single" | "dual" {
	if (width < 768) return "mobile";
	return expandedTasks && width >= Math.max(1440, sidebarWidth + 280 + 720 + 32)
		? "dual"
		: "single";
}
