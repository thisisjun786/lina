import { expect, test } from "bun:test";
import type {
	CatalogModel,
	ModelTrial,
} from "../../lina-runtime/src/models/port.ts";
import type { ModelSettings } from "../../lina-runtime/src/models/types.ts";
import {
	installModelSettings,
	profileFor,
	settingsInput,
} from "../client/model-settings.ts";

// Structural DOM fixture exercises real event handlers without a server or inference.
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
function fixture() {
	const root = new Node("dialog");
	const make = (id: string, tag = "div") => {
		const node = new Node(tag);
		node.id = id;
		root.append(node);
		return node;
	};
	const models = make("model-settings"),
		status = make("model-settings-status", "p");
	models.append(status);
	make("model-save", "button");
	make("model-reload", "button");
	make("model-test-profile", "div");
	make("model-test-prompt", "textarea");
	make("model-test", "button");
	make("model-test-result", "p");
	const find = (id: string): Node => {
		const node = [root, ...root.querySelectorAll("*"), ...walk(root)].find(
			(node) => node.id === id,
		);
		if (!node) throw Error(id);
		return node;
	};
	function walk(node: Node): Node[] {
		return node.children.flatMap((child) => [child, ...walk(child)]);
	}
	const document = {
		location: { href: "http://fixture/?agent=alpha" },
		createElement: (tag: string) => new Node(tag),
		getElementById: find,
	};
	return {
		root,
		find,
		document,
		dialog: root,
	};
}

const catalog: CatalogModel[] = [
	{
		provider: "ollama",
		id: "glm-flash",
		name: "GLM Flash",
		contextWindow: 128000,
		maxOutputTokens: 16000,
		reasoning: true,
		authenticated: true,
	},
	{
		provider: "codex",
		id: "vision",
		name: "Vision",
		contextWindow: 64000,
		maxOutputTokens: 8000,
		reasoning: true,
		authenticated: true,
		imageInput: true,
	},
	{
		provider: "unknown",
		id: "hidden",
		name: "Hidden",
		contextWindow: 64000,
		maxOutputTokens: 8000,
		reasoning: true,
		authenticated: false,
		imageInput: true,
	},
];
function setup(initial?: ModelSettings) {
	const f = fixture();
	let stored: ModelSettings = initial ?? {
		revision: 0,
		profiles: [],
		roles: {},
		agentRoles: {},
		defaultProfileId: null,
	};
	const view = installModelSettings(
		f.dialog,
		f.document,
		async (_path, method, body) => {
			if (method === "PATCH") {
				const b = body as {
					revision: number;
					settings: Omit<ModelSettings, "revision">;
				};
				stored = { ...b.settings, revision: b.revision + 1 };
				return { settings: stored };
			}
			if (method === "POST")
				return {
					provider: "ollama",
					model: "glm-flash",
					text: "OK",
					durationMs: 1,
					inputTokens: 1,
					outputTokens: 1,
				} satisfies ModelTrial;
			return { settings: stored, catalog, active: [] };
		},
	);
	return { ...f, view, stored: () => stored };
}
async function choose(f: ReturnType<typeof setup>, row: string, query: string) {
	const input = f.find(`model-${row}-input`);
	await input.fire("focus");
	input.value = query;
	await input.fire("input");
	await input.fire("keydown", "ArrowDown");
	await input.fire("keydown", "Enter");
}
test("seven direct combobox rows select and save without registration or token UI", async () => {
	const f = setup();
	await f.view.open();
	for (const role of [
		"default",
		"conversation",
		"summary",
		"observation",
		"reflection",
		"recall",
		"vision",
	])
		expect(f.find(`model-${role}-input`).attributes.get("role")).toBe(
			"combobox",
		);
	expect(() => f.find("model-output")).toThrow();
	expect(() => f.find("model-add-profile")).toThrow();
	await choose(f, "default", "glm");
	await f.find("model-save").fire("click");
	expect(f.stored().profiles[0]).toMatchObject({
		provider: "ollama",
		model: "glm-flash",
		reasoning: "low",
	});
	expect(f.stored().profiles[0]?.maxOutputTokens).toBeUndefined();
	expect(f.stored().defaultProfileId).toBe(f.stored().profiles[0]?.id ?? null);
	expect(f.find("model-conversation-input").value).toContain("전역 모델 사용");
});
test("role reasoning stays independent while its model keeps inheriting", async () => {
	const f = setup();
	await f.view.open();
	await choose(f, "default", "glm");
	const reason = f.find("model-conversation-reasoning");
	reason.value = "high";
	await reason.fire("change");
	await choose(f, "default", "vision");
	await f.find("model-save").fire("click");
	expect(f.stored().roles.conversation).toBeUndefined();
	expect(f.stored().roleReasoning?.conversation).toBe("high");
	expect(f.find("model-conversation-input").value).toContain("Vision");
	expect(f.find("model-conversation-reasoning").value).toBe("high");
});
test("search excludes unconfigured providers and unconfigured engine roles cannot edit legacy models", async () => {
	const f = setup();
	await f.view.open();
	const input = f.find("model-default-input");
	await input.fire("focus");
	expect(f.find("model-default-list").textContent).not.toContain("Hidden");
	input.value = "no match";
	await input.fire("input");
	expect(f.find("model-default-empty").textContent).toContain(
		"검색 결과가 없습니다",
	);
	await input.fire("keydown", "Enter");
	expect(f.find("model-save").disabled).toBe(true);
	const vision = f.find("model-vision-input");
	await vision.fire("focus");
	expect(f.find("model-vision-list").textContent).not.toContain("GLM Flash");
	expect(vision.disabled).toBe(true);
	expect(f.find("model-vision-hint").textContent).toContain("등급 설정이 필요");
	await vision.fire("keydown", "Escape");
	expect(vision.attributes.get("aria-expanded")).toBe("false");
});
test("agent role selection and reasoning do not change global bindings", async () => {
	const f = setup();
	await f.view.open("alpha");
	await choose(f, "default", "glm");
	await choose(f, "conversation", "vision");
	const reason = f.find("model-conversation-reasoning");
	reason.value = "medium";
	await reason.fire("change");
	await f.find("model-save").fire("click");
	expect(f.stored().roles).toEqual({});
	expect(f.stored().agentRoles["alpha"]?.conversation).toBeDefined();
	expect(f.stored().agentRoleReasoning?.["alpha"]?.conversation).toBe("medium");
	expect(
		f.stored().profiles.find((p) => p.id === f.stored().defaultProfileId)
			?.model,
	).toBe("glm-flash");
});
test("closing fences a late load failure", async () => {
	const f = fixture();
	let reject: (reason: Error) => void = () => {};
	const view = installModelSettings(
		f.dialog,
		f.document,
		() =>
			new Promise((_, r) => {
				reject = r;
			}),
	);
	const pending = view.open();
	view.close();
	const before = f.find("model-settings-status").textContent;
	reject(Error("late"));
	await pending;
	expect(f.find("model-settings-status").textContent).toBe(before);
});

test("model-name search chooses the actual model before inheritance and empty status is outside listbox", async () => {
	const f = setup();
	await f.view.open();
	await choose(f, "default", "glm");
	await choose(f, "conversation", "glm");
	await f.find("model-save").fire("click");
	expect(f.stored().roles.conversation).toBeDefined();
	const input = f.find("model-conversation-input");
	input.value = "missing";
	await input.fire("input");
	expect(f.find("model-conversation-empty").parent).not.toBe(
		f.find("model-conversation-list"),
	);
});
test("reselecting inherited model in agent scope creates no false dirty edit", async () => {
	const f = setup();
	await f.view.open("alpha");
	const input = f.find("model-summary-input");
	await input.fire("focus");
	await input.fire("keydown", "Enter");
	expect(f.find("model-save").disabled).toBe(true);
});
test("disconnected saved selection stays visible and cannot be reselected from catalog", async () => {
	const f = setup({
		revision: 1,
		profiles: [
			{ id: "old", provider: "gone", model: "old-model", reasoning: "low" },
		],
		roles: {},
		agentRoles: {},
		defaultProfileId: "old",
	});
	await f.view.open();
	expect(f.find("model-default-input").value).toContain("연결 확인 필요");
	expect(f.find("model-save").disabled).toBe(true);
	await f.find("model-default-input").fire("focus");
	expect(f.find("model-default-list").textContent).not.toContain("old-model");
});

test("model role scope includes unopened agents from the fleet catalog", async () => {
	const f = fixture();
	const view = installModelSettings(f.dialog, f.document, async () => ({
		settings: {
			revision: 0,
			profiles: [],
			roles: {},
			agentRoles: {},
			defaultProfileId: null,
		},
		catalog: [],
		active: [],
		agents: [{ id: "kai", name: "카이" }],
	}));
	await view.open();
	expect(
		f.find("model-scope").children.some((option) => option.value === "kai"),
	).toBe(true);
	view.close();
});

const routed: ModelSettings = {
	revision: 3,
	profiles: [
		{ id: "one", provider: "ollama", model: "glm-flash", reasoning: "low" },
		{ id: "two", provider: "codex", model: "vision", reasoning: "medium" },
	],
	defaultProfileId: "one",
	roles: {},
	agentRoles: { alpha: { summary: "one" } },
	routes: {
		version: 1,
		tiers: {
			quick: { profileId: "one" },
			standard: { profileId: "two", reasoning: "low" },
			deep: { profileId: "two" },
			intensive: { profileId: "two" },
		},
		roleTiers: { summary: "standard" },
	},
};

test("settings clone and save keep routes while role rows show the effective tier model", async () => {
	expect(settingsInput(routed).routes).toEqual(routed.routes);
	expect(profileFor(routed, "conversation")?.model).toBe("glm-flash");
	expect(profileFor(routed, "summary")?.model).toBe("vision");
	expect(profileFor(routed, "summary", "alpha")?.model).toBe("vision");
	expect(
		profileFor(
			{
				...routed,
				agentRoles: {},
				agentRoleReasoning: { alpha: { summary: "high" } },
			},
			"summary",
			"alpha",
		),
	).toMatchObject({ model: "vision", reasoning: "low" });
	const f = setup(routed);
	await f.view.open();
	expect(f.find("model-conversation-input").value).toContain("전역 모델 사용");
	expect(f.find("model-conversation-input").value).toContain("GLM Flash");
	expect(f.find("model-summary-input").value).toContain("등급 설정 사용");
	expect(f.find("model-summary-input").value).toContain("Vision");
	expect(f.find("model-summary-input").value).not.toContain("전역 모델 사용");
	expect(f.find("model-summary-hint").textContent).toContain("등급");
	expect(f.find("model-effective").textContent).toContain("Vision");
	expect(f.find("model-effective").textContent).toContain("등급");
	await choose(f, "conversation", "vision");
	await f.find("model-save").fire("click");
	expect(f.stored().routes).toEqual(routed.routes);
	expect(f.stored().roles.conversation).toBeDefined();
});

test("agent scope shows shared tiers and preserves dormant legacy bindings", async () => {
	const f = setup(routed);
	await f.view.open("alpha");
	expect(f.find("model-summary-input").value).toContain("Vision");
	expect(f.find("model-summary-input").value).toContain("등급 설정 사용");
	expect(f.find("model-summary-input").disabled).toBe(true);
	await f.find("model-save").fire("click");
	expect(f.find("model-save").disabled).toBe(true);
	expect(f.stored().routes).toEqual(routed.routes);
	expect(f.stored().agentRoles["alpha"]?.summary).toBe("one");
});

test("global role binding stays shadowed by an active tier and does not look selected", async () => {
	const coexist: ModelSettings = {
		...routed,
		roles: { summary: "one" },
		agentRoles: {},
	};
	expect(profileFor(coexist, "summary")?.model).toBe("vision");
	expect(profileFor(coexist, "conversation")?.model).toBe("glm-flash");
	const f = setup(coexist);
	await f.view.open();
	expect(f.find("model-summary-input").value).toContain("등급 설정 사용");
	expect(f.find("model-summary-input").value).toContain("Vision");
	expect(f.find("model-summary-input").disabled).toBe(true);
	expect(f.find("model-summary-hint").textContent).toContain("등급");
	expect(f.find("model-summary-reasoning").disabled).toBe(true);
	await choose(f, "summary", "glm");
	expect(f.find("model-save").disabled).toBe(true);
	await f.view.open("alpha");
	expect(f.find("model-summary-input").disabled).toBe(true);
	await choose(f, "summary", "glm");
	await f.find("model-save").fire("click");
	expect(f.stored().routes).toEqual(coexist.routes);
	expect(f.stored().roles.summary).toBe("one");
	expect(f.stored().agentRoles["alpha"]?.summary).toBeUndefined();
});
