import { expect, test } from "bun:test";
import {
	createModelCombobox,
	fitComboboxList,
	placedComboboxList,
} from "../client/model-combobox.ts";

const qa1280 = {
	input: { top: 424, bottom: 466 },
	clip: { top: 80, bottom: 548 },
	obstacle: { top: 500, bottom: 548 },
};

test("short dialog under sticky actions flips the list above the trigger", () => {
	const fit = fitComboboxList(qa1280);
	const box = placedComboboxList(qa1280.input, fit);
	expect(fit.placement).toBe("above");
	expect(box.bottom).toBeLessThanOrEqual(qa1280.input.top);
	expect(box.top).toBeGreaterThanOrEqual(qa1280.clip.top);
	expect(box.bottom).toBeLessThanOrEqual(qa1280.obstacle.top);
	expect(box.bottom).toBeLessThanOrEqual(qa1280.clip.bottom);
});

test("overflowing option geometry from the 1280x577 picker stays inside the dialog", () => {
	expect(596).toBeGreaterThan(548);
	const fit = fitComboboxList(qa1280);
	const box = placedComboboxList(qa1280.input, fit);
	expect(box.bottom).toBeLessThan(554);
	expect(box.bottom).toBeLessThanOrEqual(548);
});

test("enough room below keeps the list under the input and above sticky actions", () => {
	const input = { top: 120, bottom: 162 };
	const clip = { top: 80, bottom: 548 };
	const obstacle = { top: 500, bottom: 548 };
	const fit = fitComboboxList({ input, clip, obstacle });
	const box = placedComboboxList(input, fit);
	expect(fit.placement).toBe("below");
	expect(box.top).toBeGreaterThanOrEqual(input.bottom);
	expect(box.bottom).toBeLessThanOrEqual(obstacle.top);
	expect(box.bottom).toBeLessThanOrEqual(clip.bottom);
});

test("narrow mobile clip still keeps the popup inside the scrollport", () => {
	const input = { top: 620, bottom: 662 };
	const clip = { top: 140, bottom: 780 };
	const obstacle = { top: 728, bottom: 780 };
	const fit = fitComboboxList({ input, clip, obstacle });
	const box = placedComboboxList(input, fit);
	expect(fit.placement).toBe("above");
	expect(box.top).toBeGreaterThanOrEqual(clip.top);
	expect(box.bottom).toBeLessThanOrEqual(obstacle.top);
});

class Node {
	id = "";
	className = "";
	type = "";
	hidden = false;
	disabled = false;
	open = true;
	min = "";
	max = "";
	step = "";
	checked = false;
	parent?: Node;
	children: Node[] = [];
	attributes = new Map<string, string>();
	style = { maxHeight: "" };
	rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
	listeners = new Map<
		string,
		Array<
			(event: {
				key?: string;
				relatedTarget?: unknown;
				preventDefault(): void;
				stopPropagation(): void;
			}) => unknown
		>
	>();
	private text = "";
	private selected = "";
	constructor(readonly tag: string) {}
	get textContent(): string {
		return this.text + this.children.map((node) => node.textContent).join("");
	}
	set textContent(value: string) {
		this.text = value;
		this.children = [];
	}
	get value(): string {
		return this.selected;
	}
	set value(value: string) {
		this.selected = value;
	}
	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	contains(node: unknown): boolean {
		return this === node || this.children.some((child) => child.contains(node));
	}
	select() {}
	scrollIntoView() {}
	focus() {}
	checkValidity() {
		return true;
	}
	reportValidity() {
		return true;
	}
	append(...nodes: Node[]) {
		for (const node of nodes) {
			if (node.parent)
				node.parent.children = node.parent.children.filter(
					(item) => item !== node,
				);
			node.parent = this;
			this.children.push(node);
		}
	}
	replaceChildren(...nodes: Node[]) {
		this.children = [];
		this.text = "";
		this.append(...nodes);
	}
	before() {}
	after() {}
	querySelectorAll(): Node[] {
		return [];
	}
	querySelector(selector: string): Node | null {
		const cls = selector.startsWith(".") ? selector.slice(1) : "";
		const walk = (node: Node): Node | null => {
			if (cls && node.className.split(/\s+/).includes(cls)) return node;
			for (const child of node.children) {
				const found = walk(child);
				if (found) return found;
			}
			return null;
		};
		return walk(this);
	}
	closest(selector: string): Node | null {
		const cls = selector.startsWith(".") ? selector.slice(1) : "";
		for (let node: Node | undefined = this; node; node = node.parent) {
			if (selector === "dialog" && node.tag === "dialog") return node;
			if (cls && node.className.split(/\s+/).includes(cls)) return node;
		}
		return null;
	}
	getBoundingClientRect() {
		return this.rect;
	}
	addEventListener(
		event: string,
		listener: (event: {
			key?: string;
			relatedTarget?: unknown;
			preventDefault(): void;
			stopPropagation(): void;
		}) => unknown,
	) {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}
	async fire(event: string, key?: string) {
		await Promise.all(
			(this.listeners.get(event) ?? []).map((listener) =>
				listener({
					...(key ? { key } : {}),
					preventDefault() {},
					stopPropagation() {},
				}),
			),
		);
	}
}

function widget(onChange: (value: string) => void = () => {}) {
	const dialog = new Node("dialog");
	dialog.rect = {
		top: 80,
		bottom: 548,
		left: 200,
		right: 1080,
		width: 880,
		height: 468,
	};
	const content = new Node("div");
	content.className = "settings-content";
	content.rect = dialog.rect;
	const actions = new Node("div");
	actions.className = "model-actions";
	actions.rect = {
		top: 500,
		bottom: 548,
		left: 200,
		right: 1080,
		width: 880,
		height: 48,
	};
	dialog.append(content, actions);
	const combo = createModelCombobox(
		{
			location: { href: "http://fixture/" },
			createElement: (tag: string) => new Node(tag),
			getElementById: () => null,
		},
		"model-default",
		"전역 기본값",
		onChange,
	);
	const root = combo.root as Node;
	content.append(root);
	const input = combo.input as Node;
	input.rect = {
		top: 424,
		bottom: 466,
		left: 420,
		right: 820,
		width: 400,
		height: 42,
	};
	combo.set(
		[
			{ value: "mini", label: "gpt-5.4-mini · openai" },
			{ value: "codex", label: "gpt-5.6-codex · openai" },
			{ value: "sol", label: "gpt-5.6-sol · openai" },
		],
		"",
		"모델 선택…",
	);
	return { combo: { ...combo, root }, input, list: root.children[1] as Node };
}

test("opening the default picker in the short dialog applies an above placement", async () => {
	const { combo, input, list } = widget();
	await input.fire("focus");
	expect(combo.root.attributes.get("data-placement")).toBe("above");
	expect(combo.root.attributes.get("data-open")).toBe("true");
	const maxHeight = Number.parseInt(list.style.maxHeight, 10);
	expect(maxHeight).toBeGreaterThan(0);
	expect(maxHeight).toBeLessThanOrEqual(424 - 80);
	const box = placedComboboxList(input.rect, {
		placement: "above",
		maxHeight,
	});
	expect(box.bottom).toBeLessThanOrEqual(500);
});

test("keyboard search still commits a draft while the list is flipped", async () => {
	let chosen = "";
	const { combo, input, list } = widget((value) => {
		chosen = value;
	});
	await input.fire("focus");
	input.value = "sol";
	await input.fire("input");
	expect(input.value).toBe("sol");
	expect(combo.root.attributes.get("data-placement")).toBe("above");
	expect(list.textContent).toContain("gpt-5.6-sol");
	expect(list.textContent).not.toContain("gpt-5.4-mini");
	await input.fire("keydown", "ArrowDown");
	await input.fire("keydown", "Enter");
	expect(chosen).toBe("sol");
	expect(combo.root.attributes.get("data-open")).toBeUndefined();
});
