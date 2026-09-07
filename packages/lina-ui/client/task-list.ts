import {
	type TaskRecord,
	taskStatusLabel,
} from "../../lina-client/src/task-types.ts";
import type { SettingsDocument, SettingsNode } from "./model-settings.ts";

export type TaskListScope = "selected" | "all";
export type TaskAgent = { id: string; name: string };

export function parseTaskAgents(value: unknown): TaskAgent[] {
	if (
		!value ||
		typeof value !== "object" ||
		!("agents" in value) ||
		!Array.isArray(value.agents)
	)
		return [];
	return value.agents.flatMap((item: unknown) => {
		if (
			!item ||
			typeof item !== "object" ||
			!("id" in item) ||
			typeof item.id !== "string" ||
			!/^[a-z][a-z0-9-]{0,47}$/.test(item.id)
		)
			return [];
		return [
			{
				id: item.id,
				name:
					"name" in item && typeof item.name === "string" && item.name.trim()
						? item.name
						: item.id,
			},
		];
	});
}

/** Renders the same list node after the shell moves it between columns/screens. */
export function createTaskList(options: {
	document: SettingsDocument;
	list: SettingsNode;
	status: SettingsNode;
	onOpen: (id: string, opener: SettingsNode) => Promise<void>;
	onScope: (scope: TaskListScope) => Promise<void>;
}) {
	const { document: doc, list, status } = options;
	let filter = doc.getElementById("task-scope");
	if (!filter) {
		filter = doc.createElement("select");
		filter.id = "task-scope";
		status.before(filter);
	}
	filter.className = "task-scope";
	filter.setAttribute("aria-label", "작업 담당 범위");
	const selected = doc.createElement("option");
	selected.value = "selected";
	const all = doc.createElement("option");
	all.value = "all";
	all.textContent = "전체 에이전트";
	filter.replaceChildren(selected, all);
	const scopeNode = filter;
	scopeNode.addEventListener("change", () =>
		options.onScope(scopeNode.value === "all" ? "all" : "selected"),
	);
	let signature = "";
	return {
		render(
			tasks: TaskRecord[],
			ownerId: string,
			scope: TaskListScope,
			agents: TaskAgent[],
			selectedId: string | null,
		) {
			const names = new Map(agents.map((agent) => [agent.id, agent.name]));
			selected.textContent = `담당: ${names.get(ownerId) ?? ownerId}`;
			scopeNode.value = scope;
			const visible = tasks.filter(
				(task) => scope === "all" || task.ownerAgentId === ownerId,
			);
			const rows = visible.map((task) => ({
				task,
				owner: names.get(task.ownerAgentId) ?? "담당 미지정",
			}));
			const next = JSON.stringify([rows, selectedId]);
			if (next === signature) return visible.length;
			signature = next;
			const active = (
				doc as SettingsDocument & { activeElement?: SettingsNode }
			).activeElement;
			const focusId = active && list.contains(active) ? active.id : undefined;
			const scroll = (list as SettingsNode & { scrollTop?: number }).scrollTop;
			list.replaceChildren();
			for (const { task, owner } of rows) {
				const button = doc.createElement("button");
				button.type = "button";
				button.id = `task-open-${task.id}`;
				button.className = "task-link";
				button.setAttribute(
					"aria-current",
					task.id === selectedId ? "true" : "false",
				);
				const title = doc.createElement("span");
				title.className = "task-link-title";
				title.textContent = task.title;
				const meta = doc.createElement("span");
				meta.className = "task-link-meta";
				meta.textContent = `${owner} · ${taskStatusLabel(task.status)}${task.pendingApprovals.length ? ` · 확인 요청 ${task.pendingApprovals.length}개` : ""}`;
				button.append(title, meta);
				button.setAttribute(
					"aria-label",
					`${task.title} · ${meta.textContent}`,
				);
				button.addEventListener("click", () => options.onOpen(task.id, button));
				list.append(button);
			}
			if (focusId) doc.getElementById(focusId)?.focus();
			if (scroll !== undefined)
				(list as SettingsNode & { scrollTop: number }).scrollTop = scroll;
			return visible.length;
		},
	};
}
