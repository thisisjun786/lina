import type { ChatModel } from "./model.ts";
import { element, setText } from "./render.ts";
import type { createSettings } from "./settings.ts";
import { installSidebarResize } from "./sidebar-resize.ts";

export function createNavigation(
	settings: ReturnType<typeof createSettings>,
	openSearch: (opener: HTMLElement) => void,
) {
	installSidebarResize(settings);
	const sidebar = element("sidebar", HTMLElement),
		workspace = sidebar.parentElement;
	if (!workspace) throw Error("Missing workspace");
	const drawer = element("sidebar-drawer", HTMLDialogElement),
		open = element("open-sidebar", HTMLButtonElement),
		collapse = element("collapse-sidebar", HTMLButtonElement);
	const account = element("account-button", HTMLButtonElement),
		menu = element("account-menu", HTMLDivElement),
		search = element("open-search", HTMLButtonElement),
		shortcuts = element("shortcuts-dialog", HTMLDialogElement);
	const mobile = matchMedia("(max-width: 767px)"),
		mac = /Mac|iPhone|iPad/.test(navigator.platform),
		modifier = mac ? "⌘" : "Ctrl";
	setText(element("search-shortcut", HTMLElement), `${modifier} K`);
	setText(element("settings-shortcut", HTMLElement), `${modifier} ,`);
	setText(element("modifier-send-label", HTMLElement), `${modifier} + Enter`);
	for (const label of shortcuts.querySelectorAll<HTMLElement>(
		"[data-shortcut]",
	))
		setText(label, `${modifier} ${label.dataset["shortcut"]?.toUpperCase()}`);
	const items = Array.from(menu.querySelectorAll<HTMLButtonElement>("button"));
	const closeMenu = (focus = false) => {
		menu.hidden = true;
		account.setAttribute("aria-expanded", "false");
		if (focus) account.focus();
	};
	const restoreSidebar = () => {
		workspace.prepend(sidebar);
		open.setAttribute("aria-expanded", "false");
	};
	const closeDrawer = () => {
		closeMenu();
		if (drawer.open) drawer.close();
		restoreSidebar();
	};
	const opener = () => (mobile.matches ? open : account);
	const prepare = () => {
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
		const target = mobile.matches ? open : search;
		prepare();
		shortcuts.close();
		element("settings-dialog", HTMLDialogElement).close();
		openSearch(target);
	};
	account.addEventListener("click", () => {
		if (!menu.hidden) {
			closeMenu();
			return;
		}
		menu.hidden = false;
		account.setAttribute("aria-expanded", "true");
		items[0]?.focus();
	});
	menu.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeMenu(true);
			return;
		}
		if (event.key === "Tab") {
			closeMenu(true);
			return;
		}
		const index = items.indexOf(document.activeElement as HTMLButtonElement);
		if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
			event.preventDefault();
			const next =
				event.key === "Home"
					? 0
					: event.key === "End"
						? items.length - 1
						: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
							items.length;
			items[next]?.focus();
		}
	});
	document.addEventListener("pointerdown", (event) => {
		if (
			event.target instanceof Node &&
			!menu.contains(event.target) &&
			!account.contains(event.target)
		)
			closeMenu();
	});
	element("open-settings", HTMLButtonElement).addEventListener(
		"click",
		openSettings,
	);
	element("open-shortcuts", HTMLButtonElement).addEventListener("click", () => {
		const target = prepare();
		shortcuts.showModal();
		shortcuts.addEventListener("close", () => target.focus(), { once: true });
	});
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
	open.addEventListener("click", () => {
		drawer.append(sidebar);
		drawer.showModal();
		open.setAttribute("aria-expanded", "true");
	});
	element("close-sidebar", HTMLButtonElement).addEventListener(
		"click",
		closeDrawer,
	);
	drawer.addEventListener("close", restoreSidebar);
	drawer.addEventListener("click", (event) => {
		if (event.target === drawer) closeDrawer();
	});
	mobile.addEventListener("change", () => {
		if (!mobile.matches) closeDrawer();
	});
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
	};
	collapse.addEventListener("click", () => {
		settings.update({
			sidebarCollapsed: !settings.preferences.sidebarCollapsed,
		});
		updateCollapse();
	});
	updateCollapse();
	element("open-lina", HTMLButtonElement).addEventListener("click", () => {
		closeDrawer();
		element("message", HTMLTextAreaElement).focus();
	});
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
	return (model: ChatModel) => {
		const last = model.messages.findLast(
			(m) => m.role === "assistant" || m.role === "user",
		);
		setText(
			element("agent-preview", HTMLElement),
			last?.text.trim().startsWith("```")
				? "코드 답변"
				: last?.text
						.split(/\r?\n/)
						.find((line) => line.trim())
						?.replace(/^#{1,6}\s*/, "")
						.replace(/[`*_]/g, "")
						.slice(0, 100) || "대화 시작",
		);
	};
}
