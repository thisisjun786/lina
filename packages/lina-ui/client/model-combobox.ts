import { createElement, createRef } from "react";
import { flushSync } from "react-dom";
import {
	ModelCombobox,
	type ModelComboboxHandle,
} from "./components/model-combobox.tsx";
import { mountView } from "./components/mount.ts";
import type { ModelComboboxAdapter } from "./model-combobox-types.ts";
import type { SettingsDocument, SettingsNode } from "./settings-dom.ts";

/** Browser boundary: controller tests inject a factory instead of emulating React's DOM. */
export function createModelCombobox(
	doc: SettingsDocument,
	id: string,
	label: string,
	change: (value: string) => void,
): ModelComboboxAdapter {
	const root = doc.createElement("div");
	root.className = "model-combobox";
	const ref = createRef<ModelComboboxHandle>();
	// SettingsDocument is structural; this production adapter requires the real DOM.
	const view = mountView(root as unknown as HTMLElement);
	view.render(
		createElement(ModelCombobox, { id, label, onChange: change, ref }),
	);
	const handle = () => {
		if (!ref.current) throw Error("Model combobox is not mounted");
		return ref.current;
	};
	const input = handle().input;
	if (!input) throw Error("Model combobox input is not mounted");
	return {
		root,
		input: input as unknown as SettingsNode,
		close: () => flushSync(() => handle().close()),
		set: (items, value, label, disabled = false) =>
			flushSync(() => handle().set({ items, value, label, disabled })),
		disable: (disabled) => flushSync(() => handle().disable(disabled)),
	};
}
