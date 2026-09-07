export const SETTINGS_TABS = ["general", "connections", "models"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export function nextSettingsTab(
	current: SettingsTab,
	key: string,
): SettingsTab | null {
	if (key === "Home") return "general";
	if (key === "End") return "models";
	const delta =
		key === "ArrowRight" || key === "ArrowDown"
			? 1
			: key === "ArrowLeft" || key === "ArrowUp"
				? -1
				: 0;
	return delta
		? (SETTINGS_TABS[
				(SETTINGS_TABS.indexOf(current) + delta + SETTINGS_TABS.length) %
					SETTINGS_TABS.length
			] ?? current)
		: null;
}
