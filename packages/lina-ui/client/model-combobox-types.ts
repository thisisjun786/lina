import type { SettingsDocument, SettingsNode } from "./settings-dom.ts";

export interface ModelChoice {
	value: string;
	label: string;
	search?: string;
	inherited?: boolean;
}
export interface ModelComboboxAdapter {
	root: SettingsNode;
	input: SettingsNode;
	close(): void;
	set(
		items: ModelChoice[],
		value: string,
		label: string,
		disabled?: boolean,
	): void;
	disable(disabled: boolean): void;
}
export type ModelComboboxFactory = (
	doc: SettingsDocument,
	id: string,
	label: string,
	change: (value: string) => void,
) => ModelComboboxAdapter;
