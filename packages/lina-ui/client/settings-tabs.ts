import { createElement } from "react";
import { mountView } from "./components/mount.ts";
import { SettingsTabsView } from "./components/settings-tabs.tsx";
import { SETTINGS_TABS, type SettingsTab } from "./settings-tab-model.ts";

export function installSettingsTabs(
	root: HTMLElement,
	changed: (tab: SettingsTab) => void,
) {
	let current: SettingsTab = "general";
	const navigation = root.querySelector<HTMLElement>(".settings-navigation");
	if (!navigation) throw Error("Missing settings navigation");
	const panels = SETTINGS_TABS.map((id) => {
		const panel = root.querySelector<HTMLElement>(`#settings-panel-${id}`);
		if (!panel) throw Error("Missing settings panel");
		panel.hidden = id !== current;
		return { id, panel };
	});
	const label = navigation.getAttribute("aria-label") ?? "설정 유형";
	// The host stays controller-owned; the single tablist is rendered inside it.
	navigation.removeAttribute("role");
	navigation.removeAttribute("aria-label");
	navigation.removeAttribute("aria-orientation");
	const view = mountView(navigation);
	const mobile = window.matchMedia("(max-width: 767px)");
	const render = () =>
		view.render(
			createElement(SettingsTabsView, {
				value: current,
				orientation: mobile.matches ? "horizontal" : "vertical",
				label,
				select,
			}),
		);
	const select = (id: SettingsTab, focus = false) => {
		if (id !== current)
			root
				.querySelector<HTMLElement>(".settings-content")
				?.scrollTo({ top: 0 });
		current = id;
		// Content panels remain owned by the existing settings controllers.
		for (const item of panels) item.panel.hidden = item.id !== id;
		render();
		if (focus)
			navigation.querySelector<HTMLElement>(`#settings-tab-${id}`)?.focus();
		changed(id);
	};
	mobile.addEventListener("change", render);
	render();
	return {
		select,
		get current() {
			return current;
		},
	};
}
