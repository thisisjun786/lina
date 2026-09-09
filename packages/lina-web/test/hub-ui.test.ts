import { expect, test } from "bun:test";
import type { CatalogModel } from "../../lina-runtime/src/models/port.ts";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import {
	hubPresentation,
	installHubSettings,
	parseHubStatus,
	safeHubGuiUrl,
} from "../client/hub-settings.ts";
import { installModelSettings } from "../client/model-settings.ts";
import { nextSettingsTab } from "../client/settings-tab-model.ts";

class Node {
	id = "";
	className = "";
	type = "";
	hidden = false;
	attributes = new Map<string, string>();
	setAttribute(k: string, v: string) {
		this.attributes.set(k, v);
	}
	removeAttribute(k: string) {
		this.attributes.delete(k);
	}
	contains(n: unknown): boolean {
		return this === n || this.children.some((c) => c.contains(n));
	}
	select() {}
	scrollIntoView() {}
	disabled = false;
	open = true;
	focused = false;
	min = "";
	max = "";
	step = "";
	checked = false;
	parent?: Node;
	children: Node[] = [];
	private text = "";
	private selected = "";
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
	constructor(readonly tag: string) {}
	get textContent(): string {
		return this.text + this.children.map((node) => node.textContent).join("");
	}
	set textContent(value: string) {
		this.text = value;
		this.children = [];
	}
	get value(): string {
		return (
			this.selected ||
			(this.tag === "select" ? (this.children[0]?.value ?? "") : "")
		);
	}
	set value(value: string) {
		this.selected = value;
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
		this.selected = "";
		this.text = "";
		this.append(...nodes);
	}
	after(...nodes: Node[]) {
		if (!this.parent) return;
		const parent = this.parent;
		for (const node of nodes)
			if (node.parent)
				node.parent.children = node.parent.children.filter(
					(item) => item !== node,
				);
		parent.children.splice(parent.children.indexOf(this) + 1, 0, ...nodes);
		for (const node of nodes) node.parent = parent;
	}
	before(...nodes: Node[]) {
		if (!this.parent) return;
		this.parent.children.splice(
			this.parent.children.indexOf(this),
			0,
			...nodes,
		);
		for (const node of nodes) node.parent = this.parent;
	}
	querySelectorAll(tag: string): Node[] {
		return this.children.flatMap((node) => [
			...(node.tag === tag ? [node] : []),
			...node.querySelectorAll(tag),
		]);
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
	checkValidity() {
		return true;
	}
	reportValidity() {
		return true;
	}
	focus() {
		this.focused = true;
	}
}

function walk(node: Node): Node[] {
	return node.children.flatMap((child) => [child, ...walk(child)]);
}

function hubFixture() {
	const root = new Node("dialog");
	const make = (id: string, tag = "div") => {
		const node = new Node(tag);
		node.id = id;
		root.append(node);
		return node;
	};
	make("hub-status", "p");
	make("hub-error", "p");
	make("hub-summary", "p");
	make("hub-open", "a");
	make("hub-refresh", "button");
	make("hub-models", "button");
	const find = (id: string): Node => {
		const node = [root, ...walk(root)].find((item) => item.id === id);
		if (!node) throw Error(id);
		return node;
	};
	return {
		root,
		find,
		document: {
			location: { href: "http://fixture/?agent=lina" },
			createElement: (tag: string) => new Node(tag),
			getElementById: find,
		},
		dialog: root,
	};
}

function modelFixture() {
	const root = new Node("dialog");
	const make = (id: string, tag = "div") => {
		const node = new Node(tag);
		node.id = id;
		root.append(node);
		return node;
	};
	const models = make("model-settings");
	models.append(make("model-settings-status", "p"));
	make("model-save", "button");
	make("model-reload", "button");
	make("model-test-profile", "div");
	make("model-test-prompt", "textarea");
	make("model-test", "button");
	make("model-test-result", "p");
	const find = (id: string): Node => {
		const node = [root, ...walk(root)].find((item) => item.id === id);
		if (!node) throw Error(id);
		return node;
	};
	return {
		root,
		find,
		document: {
			location: { href: "http://fixture/?agent=alpha" },
			createElement: (tag: string) => new Node(tag),
			getElementById: find,
		},
		dialog: root,
	};
}

test("settings tabs wrap with arrows and support Home/End without consuming unrelated keys", () => {
	expect(nextSettingsTab("general", "ArrowRight")).toBe("connections");
	expect(nextSettingsTab("models", "ArrowDown")).toBe("general");
	expect(nextSettingsTab("general", "ArrowLeft")).toBe("models");
	expect(nextSettingsTab("models", "Home")).toBe("general");
	expect(nextSettingsTab("general", "End")).toBe("models");
	expect(nextSettingsTab("connections", "Enter")).toBeNull();
});

test("only https Tailscale GUI URLs can be opened in a new tab", () => {
	expect(safeHubGuiUrl("https://hub.example.ts.net:10100/")).toBe(
		"https://hub.example.ts.net:10100/",
	);
	expect(safeHubGuiUrl("https://hub.example.ts.net/gui")).toContain(".ts.net");
	expect(safeHubGuiUrl("http://hub.example.ts.net")).toBeNull();
	expect(safeHubGuiUrl("https://example.com")).toBeNull();
	expect(safeHubGuiUrl("https://evil.ts.net.example.com")).toBeNull();
	expect(safeHubGuiUrl("https://user:pass@hub.example.ts.net")).toBeNull();
	expect(safeHubGuiUrl("javascript:alert(1)")).toBeNull();
	expect(safeHubGuiUrl(null)).toBeNull();
});

test("hub status errors are visible and never reported as live", () => {
	const failed = parseHubStatus({
		configured: true,
		connected: false,
		guiUrl: "https://hub.example.ts.net",
		error: "인증이 만료되었습니다.",
		modelCount: 0,
	});
	const view = hubPresentation(failed);
	expect(view.live).toBe(false);
	expect(view.error).toContain("인증이 만료되었습니다");
	expect(view.summary).not.toContain("연결됨");
	const live = hubPresentation(
		parseHubStatus({
			configured: true,
			connected: true,
			guiUrl: "https://hub.example.ts.net",
			error: null,
			modelCount: 4,
		}),
	);
	expect(live.live).toBe(true);
	expect(live.summary).toContain("연결됨");
	expect(live.summary).toContain("4");
});

test("hub refresh posts an empty body and unsafe GUI links stay hidden", async () => {
	const f = hubFixture();
	const seen: Array<{ path: string; method: string; body: unknown }> = [];
	let status = {
		configured: true,
		connected: true,
		guiUrl: "http://127.0.0.1:8080",
		error: null as string | null,
		modelCount: 2,
	};
	const hub = installHubSettings(
		f.dialog,
		{
			onModels() {},
			onChanged() {},
		},
		f.document,
		async (path, method = "GET", body) => {
			seen.push({ path, method, body });
			if (path === "/api/hub/refresh")
				status = {
					...status,
					guiUrl: "https://hub.example.ts.net:10100",
					modelCount: 5,
				};
			return status;
		},
	);
	await hub.open();
	expect(f.find("hub-open").hidden).toBe(true);
	expect(f.find("hub-summary").textContent).toContain("연결됨");
	await f.find("hub-refresh").fire("click");
	expect(seen).toEqual([
		{ path: "/api/hub/status", method: "GET", body: undefined },
		{ path: "/api/hub/refresh", method: "POST", body: {} },
	]);
	expect(f.find("hub-open").hidden).toBe(false);
	expect(f.find("hub-open").attributes.get("href")).toBe(
		"https://hub.example.ts.net:10100/",
	);
	expect(f.find("hub-open").attributes.get("rel")).toContain("noopener");
	expect(f.find("hub-summary").textContent).toContain("5");
	hub.close();
});

test("role dropdowns hide unsupported catalog models and refresh keeps the draft", async () => {
	const f = modelFixture();
	const catalog: CatalogModel[] = [
		{
			provider: "opencodex",
			id: "glm-flash",
			name: "GLM Flash",
			contextWindow: 128000,
			maxOutputTokens: 16000,
			reasoning: true,
			authenticated: true,
		},
		{
			provider: "opencodex",
			id: "summary-only",
			name: "Summary Only",
			contextWindow: 64000,
			maxOutputTokens: 8000,
			reasoning: true,
			authenticated: true,
			supportedRoles: ["summary"],
		},
		{
			provider: "opencodex",
			id: "vision",
			name: "Vision",
			contextWindow: 64000,
			maxOutputTokens: 8000,
			reasoning: true,
			authenticated: true,
			imageInput: true,
			supportedRoles: ["vision"],
		},
	];
	let stored: ModelSettings = {
		revision: 0,
		profiles: [],
		roles: {},
		agentRoles: {},
		defaultProfileId: null,
	};
	let loads = 0;
	const view = installModelSettings(
		f.dialog,
		f.document,
		async (_path, method, body) => {
			if (method === "GET") {
				loads += 1;
				return {
					settings: stored,
					catalog: loads === 1 ? catalog : catalog.slice(0, 2),
					active: [],
				};
			}
			if (method === "PATCH") {
				const sent = body as {
					revision: number;
					settings: Omit<ModelSettings, "revision">;
				};
				stored = { ...sent.settings, revision: sent.revision + 1 };
				return { settings: stored };
			}
			throw Error("unexpected");
		},
	);
	await view.open();
	const conversation = f.find("model-conversation-input");
	await conversation.fire("focus");
	expect(f.find("model-conversation-list").textContent).toContain("GLM Flash");
	expect(f.find("model-conversation-list").textContent).not.toContain(
		"Summary Only",
	);
	expect(f.find("model-conversation-list").textContent).not.toContain("Vision");
	await conversation.fire("keydown", "Escape");
	const summary = f.find("model-summary-input");
	await summary.fire("focus");
	expect(summary.disabled).toBe(true);
	expect(f.find("model-summary-hint").textContent).toContain(
		"공통 처리 등급 설정이 필요",
	);
	await summary.fire("keydown", "Escape");
	const def = f.find("model-default-input");
	await def.fire("focus");
	def.value = "glm";
	await def.fire("input");
	await def.fire("keydown", "ArrowDown");
	await def.fire("keydown", "Enter");
	expect(f.find("model-save").disabled).toBe(false);
	await f.find("model-reload").fire("click");
	expect(f.find("model-save").disabled).toBe(false);
	expect(f.find("model-settings-status").textContent).toContain("유지");
	expect(f.find("model-default-input").value).toContain("GLM Flash");
});
