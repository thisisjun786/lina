export const SETTINGS_TABS = ["general", "connections", "models"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];
