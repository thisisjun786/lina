/** The browser DOM and the structural test fixture share this small surface. */
export interface SettingsNode {
	id: string;
	className: string;
	type: string;
	min: string;
	max: string;
	step: string;
	value: string;
	checked?: boolean;
	disabled: boolean;
	textContent: string | null;
	append(...nodes: SettingsNode[]): void;
	replaceChildren(...nodes: SettingsNode[]): void;
	before(...nodes: SettingsNode[]): void;
	after(...nodes: SettingsNode[]): void;
	querySelectorAll(selector: string): Iterable<SettingsNode>;
	hidden: boolean;
	setAttribute(name: string, value: string): void;
	removeAttribute(name: string): void;
	contains(node: unknown): boolean;
	select?(): void;
	scrollIntoView?(options?: { block: "nearest" }): void;
	addEventListener(
		type: string,
		listener: (event: {
			key?: string;
			relatedTarget?: unknown;
			preventDefault(): void;
			stopPropagation(): void;
		}) => unknown,
	): void;
	checkValidity(): boolean;
	reportValidity(): boolean;
	focus(): void;
}
export interface SettingsDocument {
	location: { href: string };
	getElementById(id: string): SettingsNode | null;
	createElement(tag: string): SettingsNode;
}
