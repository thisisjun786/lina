import { expect, test } from "bun:test";
import type {
	AgentChange,
	AgentProfile,
	Dynamics,
} from "../../lina-core/src/agents/types.ts";
import {
	createAgentEditor,
	createAgentPicker,
	type EditorDependencies,
	type EditorNode,
} from "../client/agent-editor.ts";

type Listener = (event: FakeEvent) => void;
class FakeEvent {
	defaultPrevented = false;
	constructor(
		readonly type: string,
		readonly currentTarget?: unknown,
	) {}
	preventDefault(): void {
		this.defaultPrevented = true;
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Listener[]>();
	private literalText = "";
	id = "";
	className = "";
	type = "";
	name = "";
	value = "";
	src = "";
	hidden = false;
	disabled = false;
	open = false;
	isConnected = true;
	focused = 0;
	clicks = 0;
	files: { name: string; size: number }[] = [];
	constructor(readonly tagName: string) {}
	get textContent(): string {
		return this.children.length
			? this.children.map((child) => child.textContent).join("")
			: this.literalText;
	}
	set textContent(value: string) {
		this.literalText = value;
		this.children.length = 0;
	}
	get elements() {
		const fields = this.find((node) => Boolean(node.name));
		return {
			namedItem: (name: string) =>
				fields.find((field) => field.name === name) ?? null,
		};
	}
	parent: FakeElement | undefined;
	append(...nodes: FakeElement[]): void {
		for (const node of nodes) node.parent = this;
		this.children.push(...nodes);
	}
	replaceChildren(...nodes: FakeElement[]): void {
		this.children.length = 0;
		this.append(...nodes);
		if (this.tagName === "select") this.value = nodes[0]?.value ?? "";
	}
	after(...nodes: FakeElement[]): void {
		const parent = this.parent;
		if (!parent) return;
		parent.children.splice(parent.children.indexOf(this) + 1, 0, ...nodes);
		for (const node of nodes) node.parent = parent;
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	addEventListener(type: string, listener: Listener): void {
		const list = this.listeners.get(type) ?? [];
		list.push(listener);
		this.listeners.set(type, list);
	}
	dispatch(type: string): FakeEvent {
		const event = new FakeEvent(type, this);
		for (const listener of this.listeners.get(type) ?? []) listener(event);
		return event;
	}
	click(): void {
		this.clicks++;
		this.dispatch("click");
	}
	focus(): void {
		this.focused++;
	}
	showModal(): void {
		this.open = true;
	}
	close(): void {
		if (!this.open) return;
		this.open = false;
		this.dispatch("close");
	}
	querySelectorAll(selector: string): FakeElement[] {
		if (selector === "[data-close]")
			return this.find((node) => node.attributes.has("data-close"));
		return this.find((node) => node.tagName === selector);
	}
	querySelector(selector: string): FakeElement | null {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	find(match: (node: FakeElement) => boolean): FakeElement[] {
		const out: FakeElement[] = [];
		for (const child of this.children) {
			if (match(child)) out.push(child);
			out.push(...child.find(match));
		}
		return out;
	}
}

function field(tag: string, name: string): FakeElement {
	const node = new FakeElement(tag);
	node.name = name;
	return node;
}

function buildDom() {
	const byId = new Map<string, FakeElement>();
	const make = (tag: string, id: string): FakeElement => {
		const node = new FakeElement(tag);
		node.id = id;
		byId.set(id, node);
		return node;
	};
	const dialog = make("dialog", "agent-dialog");
	const heading = make("h2", "agent-heading");
	const closeButton = new FakeElement("button");
	closeButton.setAttribute("data-close", "");
	const form = make("form", "agent-form");
	const image = make("img", "agent-profile-image");
	const changeAvatar = make("button", "change-agent-avatar");
	const upload = make("input", "agent-avatar-file");
	form.append(
		image,
		changeAvatar,
		upload,
		field("input", "name"),
		field("input", "role"),
		field("textarea", "personality"),
		field("textarea", "voice"),
		field("textarea", "interests"),
		field("textarea", "profile"),
		field("textarea", "appearance"),
		make("select", "agent-evolution"),
		make("div", "agent-growth"),
		make("p", "agent-edit-status"),
		make("button", "save-agent"),
	);
	dialog.append(heading, closeButton, form);

	const picker = make("dialog", "agent-create-dialog");
	const pickerClose = new FakeElement("button");
	pickerClose.setAttribute("data-close", "");
	picker.append(
		pickerClose,
		make("select", "agent-preset"),
		make("input", "new-agent-name"),
		make("p", "agent-create-error"),
		make("button", "create-agent"),
		make("form", "agent-create-form"),
	);
	const opener = new FakeElement("button");
	const fallback = make("button", "open-sidebar");
	const created: FakeElement[] = [];
	const document = {
		createElement: (tag: string) => {
			const node = new FakeElement(tag);
			created.push(node);
			return node;
		},
		getElementById: (id: string) =>
			byId.get(id) ?? created.find((node) => node.id === id) ?? null,
	};
	const find = (id: string) => {
		const found = byId.get(id);
		if (!found) throw new Error(`Missing ${id}`);
		return found as unknown as EditorNode;
	};
	return {
		byId,
		dialog,
		form,
		image,
		upload,
		opener,
		fallback,
		document,
		find,
	};
}

function profile(id: string, name: string, revision = 1): AgentProfile {
	return {
		id,
		name,
		role: `${name} role`,
		personality: "",
		voice: "",
		profile: "",
		appearance: "",
		interests: ["a", "b"],
		avatarId: null,
		evolution: "adaptive",
		revision,
	};
}
const dynamics: Dynamics = {
	revision: 3,
	mood: null,
	interests: [],
	preferences: [],
	relationship: [],
	lastRequestId: null,
};
function detailOf(id: string, name: string, changes: AgentChange[] = []) {
	return { profile: profile(id, name), dynamics, changes };
}

interface Pending {
	path: string;
	method: string;
	body: unknown;
	signal: AbortSignal | undefined;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

function harness() {
	const dom = buildDom();
	const pending: Pending[] = [];
	const request: EditorDependencies["request"] = (
		path,
		method = "GET",
		body,
		signal,
	) =>
		new Promise((resolve, reject) => {
			const entry: Pending = { path, method, body, signal, resolve, reject };
			pending.push(entry);
			signal?.addEventListener("abort", () =>
				reject(new Error(`aborted:${path}`)),
			);
		});
	const uploads: {
		path: string;
		headers: Record<string, string>;
		resolve: (r: Response) => void;
	}[] = [];
	const fetcher: EditorDependencies["fetch"] = (input, init) =>
		new Promise((resolve) => {
			uploads.push({
				path: String(input),
				headers: (init?.headers ?? {}) as Record<string, string>,
				resolve,
			});
			init?.signal?.addEventListener("abort", () =>
				resolve(new Response(null, { status: 499 })),
			);
		});
	let changedCalls = 0;
	const globals = globalThis as typeof globalThis & { document?: unknown };
	const previous = globals.document;
	globals.document = dom.document;
	const restore = () => {
		if (previous === undefined) delete globals.document;
		else globals.document = previous;
	};
	const editor = createAgentEditor(
		() => {
			changedCalls++;
		},
		{ request, fetch: fetcher, find: dom.find, document: dom.document },
	);
	const take = (path: string, method = "GET") => {
		const index = pending.findIndex(
			(entry) => entry.path === path && entry.method === method,
		);
		if (index < 0) throw new Error(`no pending ${method} ${path}`);
		return pending.splice(index, 1)[0] as Pending;
	};
	const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	const status = () => dom.byId.get("agent-edit-status")?.textContent ?? "";
	const save = dom.byId.get("save-agent") as FakeElement;
	const avatar = dom.byId.get("change-agent-avatar") as FakeElement;
	const fieldValue = (name: string) =>
		(dom.form.elements.namedItem(name) as FakeElement).value;
	return {
		...dom,
		editor,
		pending,
		uploads,
		take,
		settle,
		status,
		save,
		avatar,
		fieldValue,
		restore,
		changed: () => changedCalls,
		opener: dom.opener as unknown as EditorNode,
	};
}

test("reopening for another agent ignores the stale load and never shows the previous profile", async () => {
	const h = harness();
	try {
		const first = h.editor.open("alpha", h.opener);
		expect(h.save.disabled).toBe(true);
		expect(h.avatar.disabled).toBe(true);
		expect(h.form.getAttribute("aria-busy")).toBe("true");
		const alphaLoad = h.take("/api/agents/alpha");
		const second = h.editor.open("beta", h.opener);
		expect(alphaLoad.signal?.aborted).toBe(true);
		const betaLoad = h.take("/api/agents/beta");
		alphaLoad.resolve(detailOf("alpha", "Alpha"));
		await first;
		await h.settle();
		expect(h.fieldValue("name")).toBe("");
		betaLoad.resolve(detailOf("beta", "Beta"));
		await second;
		expect(h.fieldValue("name")).toBe("Beta");
		expect(h.fieldValue("interests")).toBe("a\nb");
		expect(h.byId.get("agent-heading")?.textContent).toBe("Beta 설정");
		expect(h.save.disabled).toBe(false);
		expect(h.avatar.disabled).toBe(false);
		expect(h.form.getAttribute("aria-busy")).toBe("false");
		expect(h.dialog.open).toBe(true);
	} finally {
		h.restore();
	}
});

test("a failed load clears the previous profile and keeps save disabled until a reload succeeds", async () => {
	const h = harness();
	try {
		const opened = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(detailOf("alpha", "Alpha"));
		await opened;
		h.dialog.close();
		const reopened = h.editor.open("beta", h.opener);
		expect(h.fieldValue("name")).toBe("");
		h.take("/api/agents/beta").reject(new Error("서버 오류"));
		await reopened;
		expect(h.dialog.open).toBe(true);
		expect(h.status()).toBe("서버 오류");
		expect(h.fieldValue("name")).toBe("");
		expect(h.save.disabled).toBe(true);
		expect(h.avatar.disabled).toBe(true);
		h.form.dispatch("submit");
		expect(h.pending.filter((entry) => entry.method === "PATCH")).toHaveLength(
			0,
		);
		const retry = h.document.getElementById("agent-retry") as FakeElement;
		expect(retry.hidden).toBe(false);
		retry.click();
		h.take("/api/agents/beta").resolve(detailOf("beta", "Beta"));
		await h.settle();
		expect(h.fieldValue("name")).toBe("Beta");
		expect(h.save.disabled).toBe(false);
		expect(retry.hidden).toBe(true);
	} finally {
		h.restore();
	}
});

test("a save that completes after the dialog moved to another agent does not close or clobber it", async () => {
	const h = harness();
	try {
		const opened = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(detailOf("alpha", "Alpha"));
		await opened;
		(h.form.elements.namedItem("name") as FakeElement).value = "Alpha 2";
		h.form.dispatch("submit");
		const patch = h.take("/api/agents/alpha", "PATCH");
		expect(patch.body).toMatchObject({
			revision: 1,
			patch: { name: "Alpha 2" },
		});
		expect(h.save.disabled).toBe(true);
		h.form.dispatch("submit");
		expect(h.pending.filter((entry) => entry.method === "PATCH")).toHaveLength(
			0,
		);
		h.dialog.close();
		expect(patch.signal?.aborted).toBe(true);
		const reopened = h.editor.open("beta", h.opener);
		h.take("/api/agents/beta").resolve(detailOf("beta", "Beta"));
		await reopened;
		patch.resolve({});
		await h.settle();
		expect(h.dialog.open).toBe(true);
		expect(h.fieldValue("name")).toBe("Beta");
		expect(h.save.disabled).toBe(false);
		expect(h.changed()).toBe(0);
	} finally {
		h.restore();
	}
});

test("a successful save closes the dialog, notifies, and returns focus to the opener or a visible fallback", async () => {
	const h = harness();
	try {
		const opened = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(detailOf("alpha", "Alpha"));
		await opened;
		h.form.dispatch("submit");
		h.take("/api/agents/alpha", "PATCH").resolve({});
		await h.settle();
		expect(h.dialog.open).toBe(false);
		expect(h.changed()).toBe(1);
		expect((h.opener as unknown as FakeElement).focused).toBe(1);
		const detached = new FakeElement("button");
		detached.isConnected = false;
		const again = h.editor.open("alpha", detached as unknown as EditorNode);
		h.take("/api/agents/alpha").resolve(detailOf("alpha", "Alpha"));
		await again;
		h.dialog.close();
		expect(h.fallback.focused).toBe(1);
	} finally {
		h.restore();
	}
});

test("an avatar upload finishing after reopen for another agent is discarded, and the revert action follows the generation", async () => {
	const h = harness();
	try {
		const opened = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(
			detailOf("alpha", "Alpha", [
				{
					id: 7,
					kind: "reflection",
					createdAt: "2026-09-06T00:00:00Z",
					sourceEntryIds: [],
					summary: "관심사 추가",
				},
			]),
		);
		await opened;
		h.avatar.click();
		expect(h.upload.clicks).toBe(1);
		h.upload.files = [{ name: "face.png", size: 10 }];
		h.upload.dispatch("change");
		expect(h.save.disabled).toBe(true);
		expect(h.avatar.disabled).toBe(true);
		const upload = h.uploads[0];
		expect(upload?.path).toBe("/api/agents/alpha/avatar");
		expect(upload?.headers["X-Lina-Revision"]).toBe("1");
		h.dialog.close();
		const reopened = h.editor.open("beta", h.opener);
		h.take("/api/agents/beta").resolve(detailOf("beta", "Beta"));
		await reopened;
		upload?.resolve(
			Response.json({ ...profile("alpha", "Alpha", 2), avatarId: "av-1" }),
		);
		await h.settle();
		expect(h.image.hidden).toBe(true);
		expect(h.image.src).toBe("");
		expect(h.save.disabled).toBe(false);
		expect(h.changed()).toBe(0);

		h.dialog.close();
		const third = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(
			detailOf("alpha", "Alpha", [
				{
					id: 7,
					kind: "reflection",
					createdAt: "2026-09-06T00:00:00Z",
					sourceEntryIds: [],
					summary: "관심사 추가",
				},
			]),
		);
		await third;
		const undo = h.byId
			.get("agent-growth")
			?.find((n) => n.tagName === "button")[0];
		expect(undo?.textContent).toBe("되돌리기");
		undo?.click();
		const revert = h.take("/api/agents/alpha/revert", "POST");
		expect(revert.body).toEqual({ revision: 3, changeId: 7 });
		expect(h.save.disabled).toBe(true);
		h.dialog.close();
		expect(revert.signal?.aborted).toBe(true);
		revert.resolve({});
		await h.settle();
		expect(h.pending).toHaveLength(0);
		expect(h.changed()).toBe(0);
	} finally {
		h.restore();
	}
});

test("oversized avatar is rejected locally and the dialog stays usable", async () => {
	const h = harness();
	try {
		const opened = h.editor.open("alpha", h.opener);
		h.take("/api/agents/alpha").resolve(detailOf("alpha", "Alpha"));
		await opened;
		h.upload.files = [{ name: "big.png", size: 2097153 }];
		h.upload.dispatch("change");
		await h.settle();
		expect(h.uploads).toHaveLength(0);
		expect(h.status()).toContain("2MB");
		expect(h.save.disabled).toBe(false);
		expect(h.upload.value).toBe("");
	} finally {
		h.restore();
	}
});

test("picker returns focus to its opener after closing", async () => {
	const h = harness();
	try {
		const navigated: string[] = [];
		const open = createAgentPicker(
			() => [{ ...profile("p1", "Preset") }],
			(id) => navigated.push(id),
			{
				request: (path, method, body) => {
					expect(path).toBe("/api/agents");
					expect(method).toBe("POST");
					expect(body).toMatchObject({ preset: "custom", name: "" });
					return Promise.resolve(profile("new", "New"));
				},
				find: h.find,
			},
		);
		const button = new FakeElement("button");
		open(new FakeEvent("click", button));
		const picker = h.byId.get("agent-create-dialog") as FakeElement;
		expect(picker.open).toBe(true);
		expect(h.byId.get("agent-preset")?.children.map((o) => o.value)).toEqual([
			"custom",
			"p1",
		]);
		(h.byId.get("agent-create-form") as FakeElement).dispatch("submit");
		await h.settle();
		expect(navigated).toEqual(["new"]);
		expect(picker.open).toBe(false);
		expect(button.focused).toBe(1);
	} finally {
		h.restore();
	}
});
