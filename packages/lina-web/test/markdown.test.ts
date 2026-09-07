import { expect, test } from "bun:test";
import {
	type MarkdownContainer,
	parseMarkdown,
	renderMarkdown,
} from "../client/markdown.ts";

type Listener = () => void;

class FakeNode {
	readonly children: FakeNode[] = [];
	readonly attributes = new Map<string, string>();
	private literalText: string | null = null;
	private readonly listeners = new Map<string, Listener[]>();

	get textContent(): string {
		return (
			this.literalText ??
			this.children.map((child) => child.textContent).join("")
		);
	}

	set textContent(value: string) {
		this.literalText = value;
		this.children.length = 0;
	}

	append(...nodes: FakeNode[]): void {
		this.literalText = null;
		for (const node of nodes) {
			if (node instanceof FakeFragment) this.append(...node.children.splice(0));
			else this.children.push(node);
		}
	}

	replaceChildren(...nodes: FakeNode[]): void {
		this.children.length = 0;
		this.literalText = null;
		this.append(...nodes);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	click(): void {
		for (const listener of this.listeners.get("click") ?? []) listener();
	}

	find(selector: string): FakeElement[] {
		return this.children.flatMap((child) => {
			const found =
				child instanceof FakeElement &&
				((selector.startsWith(".") && child.className === selector.slice(1)) ||
					(!selector.startsWith(".") && child.tagName === selector))
					? [child]
					: [];
			return found.concat(child.find(selector));
		});
	}
}

class FakeElement extends FakeNode {
	className = "";
	constructor(readonly tagName: string) {
		super();
	}
}

class FakeFragment extends FakeNode {}

class FakeDocument {
	createElement(tagName: string): FakeElement {
		return new FakeElement(tagName);
	}

	createTextNode(value: string): FakeNode {
		const node = new FakeNode();
		node.textContent = value;
		return node;
	}

	createDocumentFragment(): FakeFragment {
		return new FakeFragment();
	}
}

async function withFakeDocument<T>(
	run: (document: FakeDocument) => T | PromiseLike<T>,
): Promise<T> {
	const globals = globalThis as typeof globalThis & { document?: unknown };
	const previous = globals.document;
	globals.document = new FakeDocument();
	try {
		return await run(globals.document as FakeDocument);
	} finally {
		if (previous === undefined) delete globals.document;
		else globals.document = previous;
	}
}

async function withClipboard<T>(
	writeText: (value: string) => Promise<void>,
	run: () => T | PromiseLike<T>,
): Promise<T> {
	const globals = globalThis as typeof globalThis & { navigator?: unknown };
	const previous = globals.navigator;
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		value: { clipboard: { writeText } },
	});
	try {
		return await run();
	} finally {
		Object.defineProperty(globalThis, "navigator", {
			configurable: true,
			value: previous,
		});
	}
}

test("parses the bounded block and inline Markdown subset", () => {
	const tokens = parseMarkdown(
		"# Title\n\n- one\n- two\n\n> quoted **word**\n\n```ts\nconst value = `<tag>`;\n```\n",
	);

	expect(tokens.map((token) => token.type)).toEqual([
		"heading",
		"list",
		"quote",
		"code",
	]);
	const code = tokens[3];
	expect(code?.type).toBe("code");
	if (code?.type === "code")
		expect(code.value).toBe("const value = `<tag>`;\n");
});

test("keeps raw HTML and unsafe links inert while retaining their text", () => {
	const source =
		"<script>alert(x)</script> [run](javascript:alert(1)) ![remote](https://example.com/x.png)";
	const tokens = parseMarkdown(source);
	const serialized = JSON.stringify(tokens);

	expect(serialized).toContain(source);
	expect(serialized).not.toContain('"type":"link"');
});

test("renders only approved links and exact current-session attachments", async () => {
	await withFakeDocument((document) => {
		const container = document.createElement("div");
		const sessionId = "11111111-1111-4111-8111-111111111111";
		const attachmentId = "22222222-2222-4222-8222-222222222222";
		const source = [
			"[web](https://example.com) [mail](mailto:test@example.com)",
			`[file](/api/attachments/${attachmentId}?sessionId=${sessionId})`,
			`[foreign](/api/attachments/${attachmentId}?sessionId=other)`,
			"[bad](javascript:alert(1))",
			"<b>raw</b>",
		].join(" ");

		renderMarkdown(
			container as unknown as MarkdownContainer,
			source,
			sessionId,
		);
		const links = container.find("a");

		expect(links.map((link) => link.getAttribute("href"))).toEqual([
			"https://example.com",
			"mailto:test@example.com",
			`/api/attachments/${attachmentId}?sessionId=${sessionId}`,
		]);
		expect(container.find("b")).toHaveLength(0);
		expect(container.find("img")).toHaveLength(0);
		expect(container.textContent).toContain("<b>raw</b>");
		expect(container.textContent).toContain("[bad](javascript:alert(1))");
	});
});

test("preserves oversized input as plain text", () => {
	const source = `# heading\n${"x".repeat(65_536)}`;
	const tokens = parseMarkdown(source);

	expect(tokens).toEqual([{ type: "plain", value: source }]);
});

test("falls back to exact plain text when token or nesting limits are exceeded", () => {
	const manyLinks = Array.from(
		{ length: 2_100 },
		(_, index) => `[${index}](https://example.com/${index})`,
	).join(" ");
	const nestedQuotes = `${"> ".repeat(10)}deep`;

	expect(parseMarkdown(manyLinks)).toEqual([
		{ type: "plain", value: manyLinks },
	]);
	expect(parseMarkdown(nestedQuotes)).toEqual([
		{ type: "plain", value: nestedQuotes },
	]);
});

test("code copy exposes visible success and failure", async () => {
	const code = "first\n\nlast\n";
	const copied: string[] = [];
	await withFakeDocument(async (document) => {
		const container = document.createElement("div");
		await withClipboard(
			async (value) => {
				copied.push(value);
			},
			async () => {
				renderMarkdown(
					container as unknown as MarkdownContainer,
					`\`\`\`\n${code}\`\`\``,
				);
				const button = container.find("button")[0];
				expect(button).toBeDefined();
				button?.click();
				await Promise.resolve();
				expect(copied).toEqual([code]);
				expect(container.find(".markdown-copy-status")[0]?.textContent).toBe(
					"복사됨",
				);
			},
		);
		await withClipboard(
			async () => {
				throw new Error("clipboard unavailable");
			},
			async () => {
				renderMarkdown(
					container as unknown as MarkdownContainer,
					`\`\`\`\n${code}\`\`\``,
				);
				const button = container.find("button")[0];
				expect(button).toBeDefined();
				button?.click();
				await Promise.resolve();
				expect(container.find(".markdown-copy-status")[0]?.textContent).toBe(
					"복사 실패",
				);
			},
		);
	});

	expect(copied).toEqual([code]);
});

test("empty list rows cannot bypass the DOM node budget", () => {
	const source = "- \n".repeat(5000);
	expect(parseMarkdown(source)).toEqual([{ type: "plain", value: source }]);
});
