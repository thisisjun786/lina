import type {
	ModelChoice,
	ModelComboboxAdapter,
	ModelComboboxFactory,
} from "../../../lina-ui/client/model-combobox-types.ts";

/** Controller seam only: browser QA owns search, focus, keyboard, and popup behavior. */
export function comboboxFixture() {
	const controls = new Map<
		string,
		ModelComboboxAdapter & { items: ModelChoice[]; choose(value: string): void }
	>();
	const factory: ModelComboboxFactory = (doc, id, label, change) => {
		const root = doc.createElement("div");
		const input = doc.createElement("input");
		input.id = `${id}-input`;
		input.setAttribute("aria-label", label);
		root.append(input);
		const control = {
			root,
			input,
			items: [] as ModelChoice[],
			close() {},
			set(
				items: ModelChoice[],
				_value: string,
				display: string,
				disabled = false,
			) {
				control.items = items;
				input.value = display;
				input.disabled = disabled;
			},
			disable(disabled: boolean) {
				input.disabled = disabled;
			},
			choose(value: string) {
				if (
					input.disabled ||
					!control.items.some((item) => item.value === value)
				)
					throw Error(`Unavailable model choice: ${id}/${value}`);
				change(value);
			},
		};
		controls.set(id, control);
		return control;
	};
	const get = (id: string) => {
		const control = controls.get(id);
		if (!control) throw Error(`Missing combobox: ${id}`);
		return control;
	};
	return { factory, get };
}
