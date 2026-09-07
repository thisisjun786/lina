import { createElement } from "react";
import type { ChatModel } from "../../lina-client/src/model.ts";
import {
	type NavigationState,
	navigationLayout,
	navigationUrl,
	parseNavigation,
	type Screen,
} from "../../lina-client/src/navigation-state.ts";
import { createActionMenu } from "./components/action-menu.tsx";
import { KeyboardIcon, SettingsIcon } from "./components/icons.tsx";
import { mountView } from "./components/mount.ts";
import { TaskLayoutControl } from "./components/task-layout-control.tsx";
import { element, setText } from "./render.ts";
import type { createSettings } from "./settings.ts";
import { installSidebarResize } from "./sidebar-resize.ts";

export function createNavigation(
	settings: ReturnType<typeof createSettings>,
	openSearch: (opener: HTMLElement) => void,
	options: {
		activate: (agentId: string) => boolean;
		preserve: () => boolean;
		showTasks: () => void;
		openTask: (id: string) => void;
		closeTask: () => void;
		changed: () => void;
		cancelSelection: () => void;
	},
) {
	installSidebarResize(settings);
	const sidebar = element("sidebar", HTMLElement),
		workspace = sidebar.parentElement;
	if (!workspace) throw Error("Missing workspace");
	const open = element("open-sidebar", HTMLButtonElement),
		collapse = element("collapse-sidebar", HTMLButtonElement);
	const account = element("account-button", HTMLButtonElement),
		search = element("open-search", HTMLButtonElement),
		shortcuts = element("shortcuts-dialog", HTMLDialogElement);
	const mobile = matchMedia("(max-width: 767px)"),
		mac = /Mac|iPhone|iPad/.test(navigator.platform),
		modifier = mac ? "⌘" : "Ctrl";
	setText(element("search-shortcut", HTMLElement), `${modifier} K`);
	setText(element("modifier-send-label", HTMLElement), `${modifier} + Enter`);
	for (const label of shortcuts.querySelectorAll<HTMLElement>(
		"[data-shortcut]",
	))
		setText(label, `${modifier} ${label.dataset["shortcut"]?.toUpperCase()}`);
	const closeMenu = () => accountMenu.close();
	let state = parseNavigation(location.href);
	let previousScreen: Screen =
		state.screen === "settings" ? "agents" : state.screen;
	let extraTasks = false;
	try {
		extraTasks = localStorage.getItem("lina.tasks-column.v1") === "true";
	} catch {
		/* Storage is optional. */
	}
	const agentPane = element("agent-pane", HTMLElement);
	const taskPane = element("task-pane", HTMLElement);
	const column = element("task-column", HTMLElement);
	const layoutHost = element("task-layout-control", HTMLElement);
	const layoutView = mountView(layoutHost);
	const content = element("sidebar-content", HTMLDivElement);
	const root = document.documentElement;
	const apply = () => {
		const available =
			navigationLayout(
				window.innerWidth,
				true,
				sidebar.getBoundingClientRect().width,
			) === "dual";
		const layout = navigationLayout(
			window.innerWidth,
			extraTasks,
			sidebar.getBoundingClientRect().width,
		);
		root.dataset["layout"] = layout;
		root.dataset["screen"] = state.screen;
		root.dataset["list"] = state.screen === "tasks" ? "tasks" : "agents";
		column.hidden = layout !== "dual";
		const parent = layout === "dual" ? column : content;
		if (taskPane.parentElement !== parent) parent.append(taskPane);
		agentPane.hidden = layout !== "dual" && state.screen === "tasks";
		taskPane.hidden = layout !== "dual" && state.screen !== "tasks";
		for (const button of document.querySelectorAll<HTMLButtonElement>(
			"[data-screen]",
		))
			button.setAttribute(
				"aria-pressed",
				String(
					button.dataset["screen"] ===
						(state.screen === "conversation" ? "agents" : state.screen),
				),
			);
		layoutHost.hidden = !available;
		layoutView.render(
			createElement(TaskLayoutControl, {
				active: layout === "dual",
				onToggle: toggleTasks,
			}),
		);
	};
	function toggleTasks() {
		extraTasks = !extraTasks;
		try {
			localStorage.setItem("lina.tasks-column.v1", String(extraTasks));
		} catch {
			/* The current view still works when storage is unavailable. */
		}
		apply();
		if (extraTasks) options.showTasks();
		// Moving the pane must not lose keyboard focus. If the task pane closes,
		// return to the selected list tab rather than an invisible control.
		const target = taskPane.hidden
			? document.querySelector<HTMLElement>(
					'.list-switch [aria-pressed="true"]',
				)
			: layoutHost.querySelector<HTMLElement>("button");
		target?.focus({ preventScroll: true });
	}
	const go = (next: NavigationState, replace = false) => {
		options.cancelSelection();
		if (!options.preserve() || !options.activate(next.agentId)) {
			history.replaceState(state, "", navigationUrl(state));
			return false;
		}
		closeMenu();
		if (next.screen !== "settings") previousScreen = next.screen;
		const taskChanged = state.taskId !== next.taskId;
		state = next;
		if (next.screen !== "settings")
			element("settings-dialog", HTMLDialogElement).close();
		history[replace ? "replaceState" : "pushState"](
			state,
			"",
			navigationUrl(state),
		);
		apply();
		options.changed();
		if (taskChanged) {
			if (state.taskId) options.openTask(state.taskId);
			else options.closeTask();
		}
		if (state.screen === "tasks") options.showTasks();
		if (state.screen === "settings")
			settings.open(element("mobile-settings", HTMLButtonElement));
		return true;
	};
	const closeDrawer = () => closeMenu();
	const opener = () => (mobile.matches ? open : account);
	const prepare = () => {
		options.cancelSelection();
		const target = opener();
		closeMenu();
		closeDrawer();
		return target;
	};
	const openSettings = () => {
		const target = prepare();
		shortcuts.close();
		settings.open(target);
	};
	const showSearch = () => {
		const target = mobile.matches
			? element("mobile-search", HTMLButtonElement)
			: search;
		prepare();
		shortcuts.close();
		element("settings-dialog", HTMLDialogElement).close();
		openSearch(target);
	};
	const accountMenu = createActionMenu({
		id: "account-menu",
		label: "내 설정 메뉴",
		side: "top",
		items: [
			{
				id: "open-settings",
				label: "설정",
				icon: createElement(SettingsIcon),
				shortcut: `${modifier} ,`,
				run: openSettings,
			},
			{
				id: "open-shortcuts",
				label: "키보드 단축키",
				icon: createElement(KeyboardIcon),
				run: () => {
					const target = prepare();
					shortcuts.showModal();
					shortcuts.addEventListener("close", () => target.focus(), {
						once: true,
					});
				},
			},
		],
	});
	accountMenu.bindTrigger(account);
	for (const button of shortcuts.querySelectorAll("[data-close]"))
		button.addEventListener("click", () => shortcuts.close());
	shortcuts.addEventListener("click", (event) => {
		if (event.target === shortcuts) {
			const r = shortcuts.getBoundingClientRect();
			if (
				event.clientX < r.left ||
				event.clientX > r.right ||
				event.clientY < r.top ||
				event.clientY > r.bottom
			)
				shortcuts.close();
		}
	});
	search.addEventListener("click", showSearch);
	element("mobile-search", HTMLButtonElement).addEventListener(
		"click",
		showSearch,
	);
	open.addEventListener("click", () => {
		if (go({ agentId: state.agentId, screen: "agents" }))
			element("agent-filter", HTMLInputElement).blur();
	});
	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"[data-screen]",
	))
		button.addEventListener("click", () =>
			go({
				agentId: state.agentId,
				screen: button.dataset["screen"] as Screen,
			}),
		);
	window.addEventListener("popstate", () =>
		go(parseNavigation(location.href), true),
	);
	window.addEventListener("resize", apply);
	new ResizeObserver(apply).observe(sidebar);
	element("settings-dialog", HTMLDialogElement).addEventListener(
		"close",
		() => {
			if (state.screen === "settings")
				go({ ...state, screen: previousScreen }, true);
		},
	);
	history.replaceState(state, "", navigationUrl(state));
	apply();
	const updateCollapse = () => {
		collapse.setAttribute(
			"aria-expanded",
			String(!settings.preferences.sidebarCollapsed),
		);
		collapse.setAttribute(
			"aria-label",
			settings.preferences.sidebarCollapsed
				? "사이드바 펼치기"
				: "사이드바 접기",
		);
		collapse.title = collapse.getAttribute("aria-label") ?? "";
	};
	collapse.addEventListener("click", () => {
		settings.update({
			sidebarCollapsed: !settings.preferences.sidebarCollapsed,
		});
		updateCollapse();
	});
	updateCollapse();
	document.addEventListener("keydown", (event) => {
		if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey))
			return;
		if (event.key.toLowerCase() === "k" || event.code === "KeyK") {
			event.preventDefault();
			showSearch();
		}
		if (event.key === ",") {
			event.preventDefault();
			element("search-dialog", HTMLDialogElement).close();
			openSettings();
		}
	});
	const render = (_model: ChatModel) => {};
	return Object.assign(render, {
		navigate(agentId: string) {
			return go({ agentId, screen: "conversation" });
		},
		taskOpened(id: string) {
			options.cancelSelection();
			if (state.taskId === id) return;
			state = { agentId: state.agentId, screen: "tasks", taskId: id };
			history.pushState(state, "", navigationUrl(state));
			apply();
		},
		taskClosed() {
			if (state.taskId) {
				state = { agentId: state.agentId, screen: "tasks" };
				history.replaceState(state, "", navigationUrl(state));
			}
			apply();
		},
		get state() {
			return state;
		},
		start() {
			if (state.taskId) options.openTask(state.taskId);
			if (state.screen === "tasks") options.showTasks();
			if (state.screen === "settings")
				settings.open(element("mobile-settings", HTMLButtonElement));
		},
	});
}
