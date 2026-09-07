import type { SettingsDocument, SettingsNode } from "./model-settings.ts";

export interface ModelChoice {
	value: string;
	label: string;
	search?: string;
	inherited?: boolean;
}
export interface ComboboxBox {
	top: number;
	bottom: number;
}
export interface ComboboxListFit {
	placement: "above" | "below";
	maxHeight: number;
}
type Measurable = {
	getBoundingClientRect?: () => ComboboxBox;
	closest?: (selector: string) => Measurable | null;
	querySelector?: (selector: string) => Measurable | null;
	style?: { maxHeight: string };
};

export const COMBOBOX_LIST_GAP = 5;
export const COMBOBOX_LIST_MAX = 220;
const PREFER_BELOW = 120;

/** Keep the popup inside a clip (dialog/scrollport), flipping above sticky actions when needed. */
export function fitComboboxList(args: {
	input: ComboboxBox;
	clip: ComboboxBox;
	obstacle?: ComboboxBox | null;
	gap?: number;
	max?: number;
	preferBelow?: number;
}): ComboboxListFit {
	const gap = args.gap ?? COMBOBOX_LIST_GAP;
	const max = args.max ?? COMBOBOX_LIST_MAX;
	const preferBelow = args.preferBelow ?? PREFER_BELOW;
	const belowLimit =
		args.obstacle && args.obstacle.top < args.clip.bottom
			? Math.min(args.clip.bottom, args.obstacle.top)
			: args.clip.bottom;
	const below = Math.max(0, belowLimit - args.input.bottom - gap);
	const above = Math.max(0, args.input.top - args.clip.top - gap);
	const placement = below >= preferBelow || below >= above ? "below" : "above";
	return {
		placement,
		maxHeight: Math.max(
			0,
			Math.min(max, placement === "below" ? below : above),
		),
	};
}

export function placedComboboxList(
	input: ComboboxBox,
	fit: ComboboxListFit,
	gap = COMBOBOX_LIST_GAP,
): ComboboxBox {
	if (fit.placement === "below") {
		const top = input.bottom + gap;
		return { top, bottom: top + fit.maxHeight };
	}
	const bottom = input.top - gap;
	return { top: bottom - fit.maxHeight, bottom };
}

/** Editable combobox. DOM focus stays on the input while arrows move the active option. */
export function createModelCombobox(
	doc: SettingsDocument,
	id: string,
	label: string,
	change: (value: string) => void,
) {
	const root = doc.createElement("div");
	root.className = "model-combobox";
	const input = doc.createElement("input");
	input.id = `${id}-input`;
	input.type = "text";
	input.setAttribute("role", "combobox");
	input.setAttribute("aria-label", label);
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-expanded", "false");
	input.setAttribute("aria-controls", `${id}-list`);
	input.setAttribute("autocomplete", "off");
	input.setAttribute("placeholder", "모델 검색…");
	const list = doc.createElement("div");
	list.id = `${id}-list`;
	list.className = "model-combobox-list";
	list.setAttribute("role", "listbox");
	list.setAttribute("aria-label", `${label} 목록`);
	list.hidden = true;
	const empty = doc.createElement("p");
	empty.id = `${id}-empty`;
	empty.className = "agent-hint";
	empty.setAttribute("role", "status");
	empty.hidden = true;
	root.append(input, list, empty);
	list.addEventListener("mousedown", (e) => e.preventDefault());
	let choices: ModelChoice[] = [],
		selected = "",
		display = "모델 선택…",
		opened = false,
		query = "",
		active = -1;
	let matched: ModelChoice[] = [],
		nodes: SettingsNode[] = [];
	const listStyle = (list as SettingsNode & Measurable).style;
	const normalize = (v: string) =>
		v.trim().replace(/\s+/g, " ").toLocaleLowerCase();
	const highlight = () => {
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (!node) continue;
			node.setAttribute("data-active", String(i === active));
		}
		const node = nodes[active];
		if (node) {
			input.setAttribute("aria-activedescendant", node.id);
			node.scrollIntoView?.({ block: "nearest" });
		} else input.removeAttribute("aria-activedescendant");
	};
	const clearPlacement = () => {
		root.removeAttribute("data-open");
		root.removeAttribute("data-placement");
		if (listStyle) listStyle.maxHeight = "";
	};
	const place = () => {
		if (!opened) return;
		root.setAttribute("data-open", "true");
		const host = input as SettingsNode & Measurable;
		const inputBox = host.getBoundingClientRect?.();
		const clipEl =
			host.closest?.(".settings-content") ?? host.closest?.("dialog");
		const clipBox = clipEl?.getBoundingClientRect?.();
		if (!inputBox || !clipBox) return;
		const obstacle = (host.closest?.("dialog") ?? clipEl)
			?.querySelector?.(".model-actions")
			?.getBoundingClientRect?.();
		const fit = fitComboboxList({
			input: inputBox,
			clip: clipBox,
			obstacle: obstacle ?? null,
		});
		root.setAttribute("data-placement", fit.placement);
		if (listStyle) listStyle.maxHeight = `${Math.floor(fit.maxHeight)}px`;
	};
	const close = () => {
		opened = false;
		list.hidden = true;
		empty.hidden = true;
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
		input.value = display;
		clearPlacement();
	};
	const commit = (item: ModelChoice) => {
		selected = item.value;
		display = item.label;
		close();
		change(item.value);
	};
	const render = () => {
		const needle = normalize(query);
		matched = choices.filter(
			(c) =>
				!needle ||
				needle
					.split(" ")
					.every((part) =>
						normalize(`${c.label} ${c.search ?? ""}`).includes(part),
					),
		);
		if (needle)
			matched.sort((a, b) => Number(!!a.inherited) - Number(!!b.inherited));
		list.replaceChildren();
		nodes = [];
		// Only configured models are supplied; all matches remain keyboard reachable.
		for (const [i, item] of matched.entries()) {
			const node = doc.createElement("div");
			node.id = `${id}-option-${i}`;
			node.setAttribute("role", "option");
			node.setAttribute("aria-selected", String(item.value === selected));
			node.textContent = item.label;
			node.addEventListener("mousedown", (e) => e.preventDefault());
			node.addEventListener("click", () => commit(item));
			list.append(node);
			nodes.push(node);
		}
		empty.hidden = matched.length > 0;
		empty.textContent = matched.length ? "" : "검색 결과가 없습니다.";
		active = -1;
		highlight();
		place();
	};
	const open = () => {
		if (input.disabled || opened) return;
		opened = true;
		query = "";
		list.hidden = false;
		input.setAttribute("aria-expanded", "true");
		render();
		input.select?.();
	};
	input.addEventListener("focus", open);
	input.addEventListener("click", () => {
		open();
		input.select?.();
	});
	input.addEventListener("input", () => {
		if (input.disabled) return;
		query = input.value;
		opened = true;
		list.hidden = false;
		input.setAttribute("aria-expanded", "true");
		render();
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && opened) {
			event.preventDefault();
			event.stopPropagation();
			close();
			return;
		}
		if (event.key === "Tab") {
			close();
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			open();
			if (!matched.length) return;
			active =
				event.key === "ArrowDown"
					? (active + 1) % matched.length
					: active <= 0
						? matched.length - 1
						: active - 1;
			highlight();
			return;
		}
		if (event.key === "Enter" && opened) {
			event.preventDefault();
			const item = matched[active < 0 ? 0 : active];
			if (item) commit(item);
		}
	});
	root.addEventListener("focusout", (e) => {
		if (!root.contains(e.relatedTarget)) close();
	});
	const view = globalThis as {
		addEventListener?(
			type: string,
			listener: () => void,
			options?: boolean,
		): void;
	};
	view.addEventListener?.("resize", place);
	view.addEventListener?.("scroll", place, true);
	return {
		root,
		input,
		close,
		set(
			items: ModelChoice[],
			value: string,
			labelText: string,
			disabled = false,
		) {
			choices = items;
			selected = value;
			display = labelText;
			input.disabled = disabled;
			input.setAttribute("title", labelText);
			if (opened) {
				render();
			} else input.value = display;
		},
		disable(value: boolean) {
			input.disabled = value;
			if (value) close();
		},
	};
}
