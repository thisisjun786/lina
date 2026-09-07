import {
	nextSettingsTab,
	SETTINGS_TABS,
	type SettingsTab,
} from "./settings-tab-model.ts";

export function installSettingsTabs(
	root: HTMLElement,
	changed: (tab: SettingsTab) => void,
) {
	let current: SettingsTab = "general";
	const navigation = root.querySelector<HTMLElement>('[role="tablist"]');
	const mobile = window.matchMedia("(max-width: 767px)");
	const orientation = () =>
		navigation?.setAttribute(
			"aria-orientation",
			mobile.matches ? "horizontal" : "vertical",
		);
	orientation();
	mobile.addEventListener("change", orientation);
	const buttons = SETTINGS_TABS.map((id) => {
		const button = root.querySelector<HTMLButtonElement>(`#settings-tab-${id}`);
		const panel = root.querySelector<HTMLElement>(`#settings-panel-${id}`);
		if (!button || !panel) throw Error("Missing settings panel");
		return { id, button, panel };
	});
	const select = (id: SettingsTab, focus = false) => {
		if (id !== current)
			root
				.querySelector<HTMLElement>(".settings-content")
				?.scrollTo({ top: 0 });
		current = id;
		for (const item of buttons) {
			const selected = item.id === id;
			item.button.setAttribute("aria-selected", String(selected));
			item.button.tabIndex = selected ? 0 : -1;
			item.panel.hidden = !selected;
			if (selected && focus) item.button.focus();
		}
		changed(id);
	};
	for (const { id, button } of buttons) {
		button.addEventListener("click", () => select(id));
		button.addEventListener("keydown", (event) => {
			const next = nextSettingsTab(current, event.key);
			if (!next) return;
			event.preventDefault();
			select(next, true);
		});
	}
	return {
		select,
		get current() {
			return current;
		},
	};
}
