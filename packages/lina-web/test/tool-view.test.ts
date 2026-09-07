import { expect, test } from "bun:test";
import type { ChatMessage } from "../client/model.ts";
import {
	createToolNode,
	type ToolElement,
	updateToolNode,
} from "../client/tool-view.ts";

class FakeElement implements ToolElement {
	readonly children: FakeElement[] = [];
	readonly listeners = new Map<string, (() => void)[]>();
	className = "";
	type = "";
	open = false;
	private text = "";
	constructor(readonly tagName: string) {}
	get textContent(): string {
		return this.children.length
			? this.children.map((child) => child.textContent).join("")
			: this.text;
	}
	set textContent(value: string) {
		this.text = value;
		this.children.length = 0;
	}
	append(...nodes: FakeElement[]): void {
		this.children.push(...nodes);
	}
	addEventListener(type: string, listener: () => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}
	click(): void {
		for (const listener of this.listeners.get("click") ?? []) listener();
	}
	querySelector(selector: string): FakeElement | null {
		return this.find(selector)[0] ?? null;
	}
	find(selector: string): FakeElement[] {
		return this.children.flatMap((child) => {
			const own = selector.startsWith(".")
				? child.className.split(" ").includes(selector.slice(1))
				: child.tagName === selector;
			return (own ? [child] : []).concat(child.find(selector));
		});
	}
}
function withDocument<T>(run: () => T): T {
	const globals = globalThis as { document?: unknown };
	const previous = globals.document;
	globals.document = {
		createElement: (tag: string) => new FakeElement(tag),
	};
	try {
		return run();
	} finally {
		if (previous === undefined) delete globals.document;
		else globals.document = previous;
	}
}
const message = (patch: Partial<ChatMessage> = {}): ChatMessage => ({
	id: "entry:t1",
	sourceId: "t1",
	role: "tool",
	text: "<b>raw</b> output\nline 2",
	status: "complete",
	nextOffset: 0,
	...patch,
});

test("tool nodes are collapsed details rows with name, failure badge and no raw summary", () => {
	withDocument(() => {
		const expanded: string[] = [];
		const node = createToolNode(
			message({ tool: { name: "bash", isError: true } }),
			(id) => expanded.push(id),
		) as FakeElement;
		expect(node.tagName).toBe("details");
		expect(node.className).toBe("message tool tool-result");
		expect(node.open).toBe(false);
		const summary = node.find("summary")[0];
		if (!summary) throw new Error("missing summary");
		expect(summary.textContent).toContain("명령 실행");
		expect(summary.textContent).toContain("실패");
		expect(summary.textContent).not.toContain("raw");
		expect(node.find(".message-avatar")).toHaveLength(0);
		const badge = summary.find(".tool-badge")[0];
		expect(badge?.className).toBe("tool-badge failed");
		const body = node.find(".message-body")[0];
		expect(body?.children).toHaveLength(0);
		expect(body?.textContent).toBe("");
		const more = node.find(".message-more")[0];
		if (!more) throw new Error("missing more button");
		more.click();
		expect(expanded).toEqual(["entry:t1"]);
		expect(node.find(".message-status")).toHaveLength(1);
	});
});

test("updates keep the disclosure state and legacy rows get a generic label", () => {
	withDocument(() => {
		const node = createToolNode(message(), () => {}) as FakeElement;
		const summary = node.find("summary")[0];
		expect(summary?.textContent).toContain("도구 결과");
		expect(summary?.find(".tool-badge")[0]?.className).toBe("tool-badge");
		node.open = true;
		updateToolNode(
			node,
			message({
				status: "interrupted",
				tool: { name: "read", isError: false },
			}),
		);
		expect(node.open).toBe(true);
		expect(summary?.textContent).toContain("파일 읽기");
		expect(summary?.textContent).not.toContain("완료");
		expect(summary?.find(".tool-badge")[0]?.className).toBe("tool-badge");
		updateToolNode(node, message({ tool: { name: "read" } }));
		expect(summary?.textContent).not.toContain("완료");
		expect(summary?.find(".tool-badge")[0]?.className).toBe("tool-badge");
	});
});
